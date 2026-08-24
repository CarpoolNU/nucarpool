import { Permission } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";
import { PROFILE_TEXT_MAX_LENGTH } from "../../utils/textLimits";

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

jest.mock("../../utils/uploadToS3", () => ({
  getPresignedImageUrl: (...args: unknown[]) =>
    mockGetPresignedImageUrl(...args),
  generatePresignedUrl: jest.fn(),
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

  it("resolves { url: null } rather than undefined when there is no user id at all", async () => {
    // A session with no `user` is the only way to reach this branch. It should
    // still hand React Query something cacheable instead of an error.
    const caller = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(caller.user.getPresignedDownloadUrl({})).resolves.toEqual({
      url: null,
    });

    expect(mockGetPresignedImageUrl).not.toHaveBeenCalled();
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
};

const buildEditDb = (
  seedLocations: LocationRow[] = [],
  seedSearches: SearchRow[] = [],
) => {
  const locations = new Map(seedLocations.map((row) => [row.id, { ...row }]));
  const searches = seedSearches.map((row) => ({ ...row }));
  let created = 0;

  const prisma = {
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
    licenseSigned: true,
    ...SHARED_ADDRESS,
    startCoordLng: -71.1,
    startCoordLat: 42.31,
    companyCoordLng: -71.05,
    companyCoordLat: 42.36,
    ...overrides,
  }) as any;

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
