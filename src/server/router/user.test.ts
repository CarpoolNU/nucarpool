import { Permission, Role } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";
import { PROFILE_TEXT_MAX_LENGTH } from "../../utils/textLimits";
import { MAX_PROFILE_IMAGE_BYTES } from "../../utils/profileImage";
import { cloneState, withTransaction } from "./transactionMock";

/**
 * Contract tests for `user.getPresignedDownloadUrl` (SCRUM-242).
 *
 * The important assertion here is a negative one: this procedure must never
 * resolve `undefined`. React Query treats a query function that resolves
 * `undefined` as a *failure* — verified against @tanstack/query-core 4.41.0,
 * which dispatches `"<key> data is undefined"` — and a query sitting in the
 * error state refetches on every mount no matter what `staleTime` or
 * `refetchOnMount` say.
 *
 * That is what made every user *without* a profile picture uncacheable: their
 * avatar paid a tRPC round trip and an S3 HeadObject on every single mount,
 * forever. `{ url: null }` is a cacheable success and costs the same to
 * produce, so the shape is load-bearing rather than cosmetic.
 *
 * Follows `authorization.test.ts` and `user/favorites.test.ts`: the real
 * `appRouter` driven through `createCaller` with a fabricated session, with
 * S3 mocked out. No network, no AWS quota, no database.
 */

const mockGetPresignedImageUrl = jest.fn();
const mockGeneratePresignedUrl = jest.fn();

jest.mock("../../utils/uploadToS3", () => ({
  getPresignedImageUrl: (...args: unknown[]) =>
    mockGetPresignedImageUrl(...args),
  generatePresignedUrl: (...args: unknown[]) =>
    mockGeneratePresignedUrl(...args),
}));

const SESSION_USER = "session-user";
const OTHER_USER = "other-user";
const SIGNED = "https://carpoolnubucket.s3.us-east-2.amazonaws.com/x?sig=abc";

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (session: Session | null) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma: {},
    sesClient: { send: jest.fn() },
  } as unknown as Context);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("user.getPresignedDownloadUrl", () => {
  it("returns the signed URL for a user who has a picture", async () => {
    mockGetPresignedImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).resolves.toEqual({ url: SIGNED });

    expect(mockGetPresignedImageUrl).toHaveBeenCalledWith(OTHER_USER);
  });

  it("resolves { url: null } — never undefined — for a user with no picture", async () => {
    mockGetPresignedImageUrl.mockResolvedValueOnce(null);
    const caller = callerFor(sessionFor(SESSION_USER));

    const result = await caller.user.getPresignedDownloadUrl({
      userId: OTHER_USER,
    });

    // Spelled out separately from toEqual: `expect(undefined).toEqual({...})`
    // would fail anyway, but the point of this test is the *shape*, and a
    // future refactor that reintroduces an implicit `return` should fail on a
    // line that says why.
    expect(result).not.toBeUndefined();
    expect(result).toEqual({ url: null });
  });

  it("falls back to the session user when no userId is supplied", async () => {
    mockGetPresignedImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(caller.user.getPresignedDownloadUrl({})).resolves.toEqual({
      url: SIGNED,
    });

    expect(mockGetPresignedImageUrl).toHaveBeenCalledWith(SESSION_USER);
  });

  it('refuses a session with no user rather than calling it "no picture"', async () => {
    // A session with no `user` is the only way to reach this branch. It used to
    // answer `{ url: null }`, which is the same thing this procedure says about
    // a user who simply has not uploaded anything - so a broken session was
    // indistinguishable from an empty avatar (SCRUM-243).
    //
    // This does not weaken SCRUM-242: `{ url: null }` is still the answer for
    // every *successful* lookup that finds no object, which is the case that
    // had to stay cacheable.
    const caller = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(caller.user.getPresignedDownloadUrl({})).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );

    expect(mockGetPresignedImageUrl).not.toHaveBeenCalled();
  });

  it("still resolves { url: null } for a real user with no picture", async () => {
    // The positive control for the test above: the cacheable shape SCRUM-242
    // introduced has to survive the change that made a broken session throw.
    mockGetPresignedImageUrl.mockResolvedValueOnce(null);

    await expect(
      callerFor(sessionFor(SESSION_USER)).user.getPresignedDownloadUrl({}),
    ).resolves.toEqual({ url: null });
  });

  it("refuses a userId that could name a key outside the prefix", async () => {
    // The id is interpolated into `profile-pictures/{env}/{id}`. Real ids are
    // cuids, so nothing legitimate contains a slash or a dot.
    const caller = callerFor(sessionFor(SESSION_USER));

    for (const userId of ["../../secrets", "a/b", "a.b", "", "  "]) {
      await expect(
        caller.user.getPresignedDownloadUrl({ userId }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }

    expect(mockGetPresignedImageUrl).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys", async () => {
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ key: "anything" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an unauthenticated caller", async () => {
    const caller = callerFor(null);

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mockGetPresignedImageUrl).not.toHaveBeenCalled();
  });

  it("surfaces an S3 failure as INTERNAL_SERVER_ERROR", async () => {
    mockGetPresignedImageUrl.mockRejectedValueOnce(new Error("s3 exploded"));
    const caller = callerFor(sessionFor(SESSION_USER));

    const rejection = caller.user.getPresignedDownloadUrl({
      userId: OTHER_USER,
    });

    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});

/**
 * Upload constraints for `user.getPresignedUrl` (SCRUM-243).
 *
 * This procedure hands out a URL that writes to `profile-pictures/{env}/{id}`.
 * It used to accept `contentType: z.string()` with no size bound at all, so a
 * crafted call could obtain a URL that stored `text/html` of any length at the
 * caller's key - content later served back from an amazonaws.com origin.
 *
 * The key is derived from the session and never from input, which is why there
 * is no "upload to someone else's key" case to test: there is no parameter that
 * could express it. What is tested is the type and size boundary, and that
 * nothing gets signed when the boundary rejects.
 *
 * That the bounds are then *enforced by S3* rather than merely passed to it is a
 * separate property, pinned against the real signer in
 * `src/utils/uploadToS3.signature.test.ts`.
 */
describe("user.getPresignedUrl", () => {
  const SIGNED_PUT = "https://bucket.s3.us-east-2.amazonaws.com/put?sig=abc";

  it("signs an upload for the caller's own key", async () => {
    mockGeneratePresignedUrl.mockResolvedValueOnce(SIGNED_PUT);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedUrl({
        contentType: "image/jpeg",
        contentLength: 2048,
      }),
    ).resolves.toEqual({ url: SIGNED_PUT });

    expect(mockGeneratePresignedUrl).toHaveBeenCalledWith(
      SESSION_USER,
      "image/jpeg",
      2048,
    );
  });

  it.each(["image/jpeg", "image/png", "image/webp"] as const)(
    "accepts %s",
    async (contentType) => {
      mockGeneratePresignedUrl.mockResolvedValueOnce(SIGNED_PUT);

      await expect(
        callerFor(sessionFor(SESSION_USER)).user.getPresignedUrl({
          contentType,
          contentLength: 2048,
        }),
      ).resolves.toEqual({ url: SIGNED_PUT });
    },
  );

  it.each([
    "text/html",
    "application/javascript",
    "image/svg+xml",
    "application/octet-stream",
    "",
  ])("refuses %s without signing anything", async (contentType) => {
    // svg is in this list on purpose: it is an image type, and it can carry
    // script, so it is the one that would slip past a looser `image/*` check.
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedUrl({
        contentType: contentType as never,
        contentLength: 2048,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("refuses an upload over the size cap without signing anything", async () => {
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedUrl({
        contentType: "image/jpeg",
        contentLength: MAX_PROFILE_IMAGE_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("signs an upload of exactly the cap", async () => {
    // The positive control: the bound has to be the documented limit, not one
    // byte under it.
    mockGeneratePresignedUrl.mockResolvedValueOnce(SIGNED_PUT);

    await expect(
      callerFor(sessionFor(SESSION_USER)).user.getPresignedUrl({
        contentType: "image/jpeg",
        contentLength: MAX_PROFILE_IMAGE_BYTES,
      }),
    ).resolves.toEqual({ url: SIGNED_PUT });
  });

  it.each([0, -1, 1.5])(
    "refuses a contentLength of %p",
    async (contentLength) => {
      const caller = callerFor(sessionFor(SESSION_USER));

      await expect(
        caller.user.getPresignedUrl({
          contentType: "image/jpeg",
          contentLength,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown input keys, so a key cannot be smuggled in", async () => {
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedUrl({
        contentType: "image/jpeg",
        contentLength: 2048,
        userId: OTHER_USER,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("throws rather than resolving undefined when the session has no user", async () => {
    // It used to fall off the end of the resolver here and resolve `undefined`,
    // which React Query reports as a failed query and the UI cannot explain.
    const caller = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(
      caller.user.getPresignedUrl({
        contentType: "image/jpeg",
        contentLength: 2048,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(
      callerFor(null).user.getPresignedUrl({
        contentType: "image/jpeg",
        contentLength: 2048,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mockGeneratePresignedUrl).not.toHaveBeenCalled();
  });

  it("surfaces a signing failure as INTERNAL_SERVER_ERROR", async () => {
    mockGeneratePresignedUrl.mockRejectedValueOnce(new Error("s3 exploded"));

    const rejection = callerFor(sessionFor(SESSION_USER)).user.getPresignedUrl({
      contentType: "image/jpeg",
      contentLength: 2048,
    });

    await expect(rejection).rejects.toBeInstanceOf(TRPCError);
    await expect(rejection).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});

/**
 * End-to-end wiring for Location ownership in `user.edit` (SCRUM-232).
 *
 * `locationOwnership.test.ts` covers the decision logic. What is left to get
 * wrong is the wiring: passing the wrong slot's coordinates, reading the
 * previous ids from the wrong place, or writing back an id the resolver did
 * not return. None of that would fail a type check, and all of it is silent —
 * the save appears to succeed and the pin is simply in the wrong place.
 *
 * The double models the tables `edit` touches and applies writes to an
 * in-memory store, so the assertion can be about the state a save leaves
 * behind rather than about which arguments Prisma received.
 */

type LocationRow = {
  id: string;
  street: string;
  city: string;
  state: string;
  streetAddress: string;
  coordLng: number;
  coordLat: number;
};

type SearchRow = {
  id: string;
  userId: string;
  homeLocationId: string;
  companyLocationId: string;
  /** Only the group guard reads these (SCRUM-289). */
  role?: Role;
  carpoolId?: string | null;
};

const buildEditDb = (
  seedLocations: LocationRow[] = [],
  seedSearches: SearchRow[] = [],
) => {
  const locations = new Map(seedLocations.map((row) => [row.id, { ...row }]));
  const searches = seedSearches.map((row) => ({ ...row }));
  let created = 0;

  const delegates = {
    user: {
      update: jest.fn(async ({ where }: any) => ({ id: where.id })),
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        carpoolSearches: searches
          .filter((s) => s.userId === where.id)
          .map((s) => ({
            ...s,
            homeLocation: locations.get(s.homeLocationId) ?? null,
            companyLocation: locations.get(s.companyLocationId) ?? null,
          })),
      })),
    },
    location: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `loc-created-${++created}`, ...data };
        locations.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = locations.get(where.id);
        if (!row) {
          throw new Error(`No location row matching where.id=${where.id}`);
        }
        Object.assign(row, data);
        return row;
      }),
    },
    carpoolSearch: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          searches.find((s) => s.userId === where.userId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) => {
        const [home, company] = where.OR;
        return searches
          .filter(
            (s) =>
              s.homeLocationId === home.homeLocationId ||
              s.companyLocationId === company.companyLocationId,
          )
          .map((s) => ({ id: s.id }));
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = searches.find((s) => s.id === where.id);
        if (!row) {
          throw new Error(`No carpoolSearch matching where.id=${where.id}`);
        }
        Object.assign(row, data);
        return row;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `search-created-${++created}`, ...data };
        searches.push(row);
        return row;
      }),
    },
  };

  // `user.edit` commits the user row, both Locations and the CarpoolSearch as
  // one transaction (SCRUM-233), so the mock rolls back on a throw. `created`
  // is restored too, otherwise generated ids would keep advancing across a
  // rolled-back attempt and the next one would not reuse them.
  const prisma = withTransaction(
    delegates,
    () => ({
      locations: cloneState(locations),
      searches: cloneState(searches),
      created,
    }),
    (before) => {
      locations.clear();
      for (const [id, row] of before.locations) locations.set(id, row);
      searches.length = 0;
      searches.push(...before.searches);
      created = before.created;
    },
  );

  return {
    prisma,
    searchFor: (userId: string) => searches.find((s) => s.userId === userId),
    locationById: (id: string | undefined) =>
      id ? locations.get(id) : undefined,
    homeOf: (userId: string) =>
      locations.get(
        searches.find((s) => s.userId === userId)?.homeLocationId ?? "",
      ),
    companyOf: (userId: string) =>
      locations.get(
        searches.find((s) => s.userId === userId)?.companyLocationId ?? "",
      ),
  };
};

const editCallerFor = (userId: string, db: ReturnType<typeof buildEditDb>) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

/** Both users submit the same address strings, at different points on it. */
const SHARED_ADDRESS = {
  startStreet: "Huntington Ave",
  startCity: "Boston",
  startState: "Massachusetts",
  startAddress: "Huntington Ave, Boston, Massachusetts",
  companyStreet: "Congress St",
  companyCity: "Boston",
  companyState: "Massachusetts",
  companyAddress: "Congress St, Boston, Massachusetts",
};

const editInput = (overrides: Record<string, unknown> = {}) =>
  ({
    role: "DRIVER",
    status: "ACTIVE",
    seatAvail: 3,
    companyName: "Acme",
    preferredName: "Sam",
    pronouns: "",
    isOnboarded: true,
    daysWorking: "0,1,1,1,1,1,0",
    coopStartDate: null,
    coopEndDate: null,
    bio: "",
    ...SHARED_ADDRESS,
    startCoordLng: -71.1,
    startCoordLat: 42.31,
    companyCoordLng: -71.05,
    companyCoordLat: 42.36,
    ...overrides,
  }) as any;

/**
 * Terms acceptance is recorded by `user.acceptTerms` and by nothing else
 * (SCRUM-240). It used to be set to `true` by every profile save, which made
 * `licenseSigned` a record of "this user saved a profile" rather than of consent
 * to a liability disclaimer written on behalf of the university.
 */
describe("user.acceptTerms", () => {
  const acceptCallerFor = (session: Session | null, prisma: unknown) =>
    appRouter.createCaller({
      req: undefined,
      res: undefined,
      session,
      prisma,
      sesClient: { send: jest.fn() },
    } as unknown as Context);

  it("records the acceptance against the caller, and writes nothing else", async () => {
    const update = jest.fn(async ({ where }: any) => ({
      id: where.id,
      licenseSigned: true,
    }));

    await acceptCallerFor(sessionFor(SESSION_USER), {
      user: { update },
    }).user.acceptTerms();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: SESSION_USER },
      data: { licenseSigned: true },
    });
  });

  it("cannot be used to record an acceptance for somebody else", async () => {
    // There is no input, so the only id available is the session's. Worth
    // pinning: a `userId` parameter here would let any caller sign the terms on
    // another user's behalf.
    const update = jest.fn(async ({ where }: any) => ({ id: where.id }));

    await acceptCallerFor(sessionFor(OTHER_USER), {
      user: { update },
    }).user.acceptTerms();

    expect(update).toHaveBeenCalledWith({
      where: { id: OTHER_USER },
      data: { licenseSigned: true },
    });
  });

  it("rejects an unauthenticated caller", async () => {
    const update = jest.fn();

    await expect(
      acceptCallerFor(null, { user: { update } }).user.acceptTerms(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(update).not.toHaveBeenCalled();
  });
});

describe("user.edit — terms acceptance is not a profile field (SCRUM-240)", () => {
  it("never writes licenseSigned, even when a client sends it", async () => {
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    // An older client would still send this; Zod strips it and the resolver no
    // longer reads it, so a stale bundle cannot flip the flag.
    await caller.user.edit(editInput({ licenseSigned: true }));

    expect(db.prisma.user.update).toHaveBeenCalled();
    for (const call of db.prisma.user.update.mock.calls) {
      expect((call[0] as any).data).not.toHaveProperty("licenseSigned");
    }
  });
});

describe("user.edit — Location ownership", () => {
  it("stores the coordinates the client submitted", async () => {
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    await caller.user.edit(editInput());

    expect(db.homeOf(SESSION_USER)).toMatchObject({
      coordLng: -71.1,
      coordLat: 42.31,
      street: "Huntington Ave",
    });
    expect(db.companyOf(SESSION_USER)).toMatchObject({
      coordLng: -71.05,
      coordLat: 42.36,
      street: "Congress St",
    });
  });

  it("does not adopt another user's row for an identical address", async () => {
    // The reported bug: whoever saved these strings first decided where
    // everyone else's pin went.
    const db = buildEditDb(
      [
        {
          id: "loc-theirs-home",
          street: "Huntington Ave",
          city: "Boston",
          state: "Massachusetts",
          streetAddress: "Huntington Ave, Boston, Massachusetts",
          coordLng: -71.2,
          coordLat: 42.4,
        },
        {
          id: "loc-theirs-company",
          street: "Congress St",
          city: "Boston",
          state: "Massachusetts",
          streetAddress: "Congress St, Boston, Massachusetts",
          coordLng: -71.25,
          coordLat: 42.45,
        },
      ],
      [
        {
          id: "search-theirs",
          userId: OTHER_USER,
          homeLocationId: "loc-theirs-home",
          companyLocationId: "loc-theirs-company",
        },
      ],
    );

    await editCallerFor(SESSION_USER, db).user.edit(editInput());

    expect(db.homeOf(SESSION_USER)).toMatchObject({
      coordLng: -71.1,
      coordLat: 42.31,
    });
    // The other user has not been moved.
    expect(db.homeOf(OTHER_USER)).toMatchObject({
      coordLng: -71.2,
      coordLat: 42.4,
    });
    expect(db.searchFor(SESSION_USER)?.homeLocationId).not.toBe(
      "loc-theirs-home",
    );
  });

  it("lets a user correct their own coordinates without changing the address", async () => {
    // Re-picking a nearby Mapbox suggestion that parses to the same strings
    // used to appear to save and move nothing.
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    await caller.user.edit(editInput());
    const firstHomeId = db.searchFor(SESSION_USER)?.homeLocationId;

    await caller.user.edit(
      editInput({ startCoordLng: -71.15, startCoordLat: 42.29 }),
    );

    expect(db.homeOf(SESSION_USER)).toMatchObject({
      coordLng: -71.15,
      coordLat: 42.29,
    });
    // Same row rewritten, so the second save left nothing behind.
    expect(db.searchFor(SESSION_USER)?.homeLocationId).toBe(firstHomeId);
    expect(db.prisma.location.create).toHaveBeenCalledTimes(2);
  });
});

/**
 * `user.edit` writes four `VARCHAR(191)` columns — `user.bio`,
 * `user.preferred_name`, `user.pronouns` and `carpool_search.company_name` —
 * and every one of them arrived as an unbounded `z.string()` (SCRUM-231).
 * MySQL runs in strict mode, so an oversized value failed the whole profile
 * save inside Prisma rather than being refused at the boundary.
 */
describe("user.edit — profile text is bounded by its columns (SCRUM-231)", () => {
  const fields = ["bio", "preferredName", "pronouns", "companyName"] as const;
  const atLimit = "a".repeat(PROFILE_TEXT_MAX_LENGTH);

  it.each(fields)(
    "rejects an over-length %s, writing nothing",
    async (field) => {
      const db = buildEditDb();
      const caller = editCallerFor(SESSION_USER, db);

      await expect(
        caller.user.edit(editInput({ [field]: `${atLimit}!` })),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(db.prisma.location.create).not.toHaveBeenCalled();
      expect(db.prisma.carpoolSearch.create).not.toHaveBeenCalled();
    },
  );

  it.each(fields)("saves %s at exactly the column width", async (field) => {
    // The positive control: the cap has to sit at the column width, not below
    // it, or it silently becomes a shorter product limit nobody chose.
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    await expect(
      caller.user.edit(editInput({ [field]: atLimit })),
    ).resolves.toBeDefined();
  });

  it("leaves the address fields unbounded", async () => {
    // These are filled from a Mapbox suggestion rather than typed, and capping
    // them would only exchange one kind of failed save for another.
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    await expect(
      caller.user.edit(editInput({ companyAddress: "a".repeat(500) })),
    ).resolves.toBeDefined();
  });
});

/**
 * `user.edit` is the boundary that writes coordinates and co-op dates to the
 * database, and it range-checked neither (SCRUM-302).
 *
 * Nothing downstream catches either one. `coord_lat` / `coord_lng` are plain
 * `Float`, `start_date` / `end_date` are independent `Date`, so the save
 * succeeds and the row is then quietly excluded from the searches it should
 * appear in - no error anywhere, at any layer.
 *
 * The assertions are all "and writes nothing": the value being refused matters
 * less than the refusal happening before the transaction opens.
 */
describe("user.edit - coordinates are range-checked (SCRUM-302)", () => {
  const coordinateFields = [
    "startCoordLng",
    "startCoordLat",
    "companyCoordLng",
    "companyCoordLat",
  ] as const;

  const outOfRange: Record<(typeof coordinateFields)[number], number[]> = {
    startCoordLng: [-180.1, 180.1],
    startCoordLat: [-90.1, 90.1],
    companyCoordLng: [-180.1, 180.1],
    companyCoordLat: [-90.1, 90.1],
  };

  it.each(coordinateFields)(
    "rejects %s outside WGS 84, writing nothing",
    async (field) => {
      for (const value of outOfRange[field]) {
        const db = buildEditDb();

        await expect(
          editCallerFor(SESSION_USER, db).user.edit(
            editInput({ [field]: value }),
          ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(db.prisma.user.update).not.toHaveBeenCalled();
        expect(db.prisma.location.create).not.toHaveBeenCalled();
        expect(db.prisma.carpoolSearch.create).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a latitude that is only valid as a longitude", async () => {
    // What a swapped pair looks like. 100 passes a bare `z.number()` and passes
    // a longitude check, so this is the case the two schemas have to separate.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ startCoordLat: 100 }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects NaN, which every comparison would otherwise pass", async () => {
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ companyCoordLat: NaN }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it.each([-180, 180])("accepts longitude %s", async (value) => {
    // The positive control: the bound is inclusive, so the antimeridian is a
    // place and not an error.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ startCoordLng: value, companyCoordLng: value }),
      ),
    ).resolves.toBeDefined();
  });

  it.each([-90, 90])("accepts latitude %s", async (value) => {
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ startCoordLat: value, companyCoordLat: value }),
      ),
    ).resolves.toBeDefined();
  });
});

describe("user.edit - unresolved coordinates are refused (SCRUM-302)", () => {
  // `[0, 0]` is `useAddressSelection`'s "nothing picked yet" default, and it is
  // inside the valid range. A profile saved before the address resolved put the
  // pin ~4000 miles from Boston, so the row matched nobody.
  const UNSET_HOME = { startCoordLng: 0, startCoordLat: 0 };
  const UNSET_COMPANY = { companyCoordLng: 0, companyCoordLat: 0 };

  it.each([Role.RIDER, Role.DRIVER])(
    "refuses a %s whose home never resolved",
    async (role) => {
      const db = buildEditDb();

      await expect(
        editCallerFor(SESSION_USER, db).user.edit(
          editInput({ role, seatAvail: 2, ...UNSET_HOME }),
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(db.prisma.location.create).not.toHaveBeenCalled();
      expect(db.prisma.carpoolSearch.create).not.toHaveBeenCalled();
    },
  );

  it("refuses a company address that never resolved", async () => {
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ ...UNSET_COMPANY }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lets a VIEWER save with no resolved address", async () => {
    // A VIEWER has no address to resolve and `user.me` already reports (0, 0)
    // for a row with no Location, so refusing this would make their profile
    // unsaveable rather than fixing anything.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          role: Role.VIEWER,
          seatAvail: 0,
          ...UNSET_HOME,
          ...UNSET_COMPANY,
          startAddress: "",
          companyAddress: "",
        }),
      ),
    ).resolves.toBeDefined();

    expect(db.homeOf(SESSION_USER)).toMatchObject({ coordLng: 0, coordLat: 0 });
  });

  it("accepts a point on one axis, which is a real place", async () => {
    // Greenwich, and the equator. Only the exact pair is the sentinel; treating
    // either component alone as unresolved would refuse legitimate saves.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          startCoordLng: 0,
          startCoordLat: 51.48,
          companyCoordLng: -78.45,
          companyCoordLat: 0,
        }),
      ),
    ).resolves.toBeDefined();
  });
});

describe("user.edit - co-op dates must run forwards (SCRUM-302)", () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  it("refuses a reversed range, writing nothing", async () => {
    // Stored as submitted, this makes `dateOverlapFilter`'s full-overlap branch
    // unsatisfiable for every candidate, so the user vanishes from those
    // searches with no indication why.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day("2027-01-31"),
          coopEndDate: day("2026-01-31"),
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.prisma.user.update).not.toHaveBeenCalled();
    expect(db.prisma.carpoolSearch.create).not.toHaveBeenCalled();
  });

  it("accepts a forward range", async () => {
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day("2026-01-31"),
          coopEndDate: day("2026-06-30"),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("accepts a single-month co-op", async () => {
    // Both pickers store the last day of the month chosen, so one month means
    // two identical dates. Requiring a strict increase would break that.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day("2026-03-31"),
          coopEndDate: day("2026-03-31"),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("still accepts a range that is not fully set", async () => {
    // Whether both are required is `onboardSchema`'s question. A VIEWER has
    // neither, and half-set combinations have always been storable here.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ coopStartDate: day("2026-01-31"), coopEndDate: null }),
      ),
    ).resolves.toBeDefined();
  });

  it("accepts an overnight shift", async () => {
    // Deliberately not checked: startTime/endTime are times of day rather than
    // a range, and `minutesApart` measures them round the clock. A night shift
    // finishing before it started is legal - see `src/server/db/README.md`.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          startTime: "1970-01-01T22:00:00.000Z",
          endTime: "1970-01-01T06:00:00.000Z",
        }),
      ),
    ).resolves.toBeDefined();
  });
});

/**
 * Atomicity of `user.edit` (SCRUM-233).
 *
 * One profile save writes the user row, two `Location` rows and a
 * `CarpoolSearch`. These were four independent awaits, so a failure part-way
 * through committed the earlier ones — profile fields saved against stale
 * carpool data, or rewritten coordinates pointing at a search that was never
 * updated. `relationMode = "prisma"` rejects none of it.
 */
describe("user.edit is atomic", () => {
  const existingProfile = () =>
    buildEditDb(
      [
        {
          id: "loc-home",
          street: "Old St",
          city: "Boston",
          state: "Massachusetts",
          streetAddress: "Old St, Boston, Massachusetts",
          coordLng: -71.9,
          coordLat: 42.9,
        },
        {
          id: "loc-company",
          street: "Old Company St",
          city: "Boston",
          state: "Massachusetts",
          streetAddress: "Old Company St, Boston, Massachusetts",
          coordLng: -71.8,
          coordLat: 42.8,
        },
      ],
      [
        {
          id: "search-mine",
          userId: SESSION_USER,
          homeLocationId: "loc-home",
          companyLocationId: "loc-company",
        },
      ],
    );

  it("does not rewrite the Locations when the CarpoolSearch write fails", async () => {
    const db = existingProfile();

    // The two Location rows are rewritten in place before the search is
    // updated, so failing the last write is what used to leave a user's pins
    // moved to an address their profile never adopted.
    db.prisma.carpoolSearch.update.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(editInput()),
    ).rejects.toThrow("connection lost");

    expect(db.locationById("loc-home")).toMatchObject({
      street: "Old St",
      coordLng: -71.9,
      coordLat: 42.9,
    });
    expect(db.locationById("loc-company")).toMatchObject({
      street: "Old Company St",
      coordLng: -71.8,
      coordLat: 42.8,
    });
  });

  it("creates no Location rows when the CarpoolSearch write fails for a new profile", async () => {
    // With no existing search, both Locations are *created* rather than
    // updated. Rolling back has to remove them, or every failed first save
    // would leave a pair of rows nothing points at.
    const db = buildEditDb();

    db.prisma.carpoolSearch.create.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(editInput()),
    ).rejects.toThrow("connection lost");

    expect(db.searchFor(SESSION_USER)).toBeUndefined();
    expect(db.locationById("loc-created-1")).toBeUndefined();
    expect(db.locationById("loc-created-2")).toBeUndefined();
  });
});

/**
 * A driver in a carpool group cannot change role out of it (SCRUM-289).
 *
 * SCRUM-125 added this as a `toast.error` in the profile page; the profile
 * redesign deleted the handler in December 2024 and nothing replaced it, so
 * this went unguarded for over a year. It was never server-side even before
 * that, so a direct call to the procedure always bypassed it.
 *
 * Why it matters more than a validation nicety: dropping a group's only DRIVER
 * leaves a state nothing can recover from. `requireGroupDriver` throws
 * FORBIDDEN for every member of a driverless group, so no member can remove
 * another and no member can dissolve it, and `groups.me` reads the shared
 * preferences through the driver's own search, so the riders' notes go blank.
 *
 * These tests exist so the next refactor of the profile page cannot silently
 * take the guard with it: the invariant is asserted against the procedure, not
 * against the form.
 */
describe("user.edit — a driver in a group cannot change role (SCRUM-289)", () => {
  const GROUP = "group-1";

  /**
   * The two rows a seeded search owns. `resolveOwnedLocations` updates them in
   * place, so they have to exist or the save fails for an unrelated reason.
   */
  const ownedLocations = (): LocationRow[] => [
    {
      id: "loc-home",
      street: "Huntington Ave",
      city: "Boston",
      state: "Massachusetts",
      streetAddress: "Huntington Ave, Boston, Massachusetts",
      coordLng: -71.1,
      coordLat: 42.31,
    },
    {
      id: "loc-company",
      street: "Congress St",
      city: "Boston",
      state: "Massachusetts",
      streetAddress: "Congress St, Boston, Massachusetts",
      coordLng: -71.05,
      coordLat: 42.36,
    },
  ];

  /** One existing search for the caller, in whatever role and group state. */
  const callerWith = (role: Role, carpoolId: string | null) =>
    buildEditDb(ownedLocations(), [
      {
        id: "search-mine",
        userId: SESSION_USER,
        homeLocationId: "loc-home",
        companyLocationId: "loc-company",
        role,
        carpoolId,
      },
    ]);

  /** A driver whose search is already attached to a group. */
  const driverInGroup = () => callerWith(Role.DRIVER, GROUP);

  it.each([Role.RIDER, Role.VIEWER])(
    "refuses a switch to %s and writes nothing",
    async (role) => {
      const db = driverInGroup();

      await expect(
        editCallerFor(SESSION_USER, db).user.edit(editInput({ role })),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      // The guard throws inside the transaction, after the `user.update`, so
      // this also pins the rollback: a refused role change must not leave the
      // profile fields half-saved.
      expect(db.searchFor(SESSION_USER)).toMatchObject({
        role: Role.DRIVER,
        carpoolId: GROUP,
      });
      expect(db.prisma.user.update).toHaveBeenCalled();
    },
  );

  it("allows a driver in a group to save other fields", async () => {
    const db = driverInGroup();

    await editCallerFor(SESSION_USER, db).user.edit(
      editInput({ role: Role.DRIVER, bio: "Still driving" }),
    );

    expect(db.searchFor(SESSION_USER)).toMatchObject({
      role: Role.DRIVER,
      carpoolId: GROUP,
    });
  });

  it("allows a driver with no group to become a rider", async () => {
    // The guard is about the group, not about the role. Leaving a group is the
    // documented way out, and afterwards this has to work.
    const db = callerWith(Role.DRIVER, null);

    await editCallerFor(SESSION_USER, db).user.edit(
      editInput({ role: Role.RIDER, seatAvail: 0 }),
    );

    expect(db.searchFor(SESSION_USER)).toMatchObject({ role: Role.RIDER });
  });

  it("allows a rider in a group to save their profile", async () => {
    // Only the driver is load-bearing for the group, so a rider is untouched
    // by this guard.
    const db = callerWith(Role.RIDER, GROUP);

    await editCallerFor(SESSION_USER, db).user.edit(
      editInput({ role: Role.RIDER, seatAvail: 0 }),
    );

    expect(db.searchFor(SESSION_USER)).toMatchObject({
      role: Role.RIDER,
      carpoolId: GROUP,
    });
  });

  it("does not block a first-time save with no existing search", async () => {
    // Onboarding: there is no CarpoolSearch yet, so there is no group to
    // strand and the guard must not fire on the create path.
    const db = buildEditDb();

    await editCallerFor(SESSION_USER, db).user.edit(
      editInput({ role: Role.RIDER, seatAvail: 0 }),
    );

    expect(db.searchFor(SESSION_USER)).toMatchObject({ role: Role.RIDER });
  });
});
