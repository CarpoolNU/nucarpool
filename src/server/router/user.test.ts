import { Permission, Prisma, Role, Status } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";
import { PROFILE_TEXT_MAX_LENGTH } from "../../utils/textLimits";
import { CURRENT_TERMS_VERSION } from "../../utils/termsAcceptance";
import { MAX_PROFILE_IMAGE_BYTES } from "../../utils/profileImage";
import { cloneState, withTransaction } from "./transactionMock";
import dayjs from "dayjs";
import utcPlugin from "dayjs/plugin/utc";
import timezonePlugin from "dayjs/plugin/timezone";
import {
  SCHEDULE_TIMEZONE,
  toStoredScheduleTime,
} from "../../utils/scheduleTime";
import {
  COOP_DATE_ORDER_MESSAGE,
  coopYearBounds,
  coopYearMessage,
} from "../../utils/dateUtils";

dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

/**
 * Contract tests for `user.getPresignedDownloadUrl`.
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

const mockGeneratePresignedUrl = jest.fn();
const mockSignProfileImageUrl = jest.fn();

jest.mock("../../utils/uploadToS3", () => ({
  generatePresignedUrl: (...args: unknown[]) =>
    mockGeneratePresignedUrl(...args),
  signProfileImageUrl: (...args: unknown[]) => mockSignProfileImageUrl(...args),
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

/**
 * `getPresignedDownloadUrl` reads `User.profilePictureUpdatedAt` to decide
 * whether the user has a picture at all, so the caller needs a
 * `user.findUnique`.
 *
 * The default is `null` - no picture - which is what most users look like.
 * A test that wants a picture records one with `withRecordedPicture`.
 */
const mockUserFindUnique = jest.fn();
const mockUserUpdate = jest.fn();

const callerFor = (session: Session | null) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma: {
      user: {
        findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
        update: (...args: unknown[]) => mockUserUpdate(...args),
      },
    },
    sesClient: { send: jest.fn() },
  } as unknown as Context);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindUnique.mockResolvedValue({ profilePictureUpdatedAt: null });
  mockUserUpdate.mockResolvedValue({});
});

const withRecordedPicture = () =>
  mockUserFindUnique.mockResolvedValue({
    profilePictureUpdatedAt: new Date("2026-09-03T12:00:00Z"),
  });

describe("user.getPresignedDownloadUrl", () => {
  it("returns the signed URL for a user who has a picture", async () => {
    withRecordedPicture();
    mockSignProfileImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).resolves.toEqual({ url: SIGNED });

    expect(mockSignProfileImageUrl).toHaveBeenCalledWith(OTHER_USER);
  });

  it("resolves { url: null } — never undefined — for a user with no picture", async () => {
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
    withRecordedPicture();
    mockSignProfileImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(caller.user.getPresignedDownloadUrl({})).resolves.toEqual({
      url: SIGNED,
    });

    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: SESSION_USER },
      select: { profilePictureUpdatedAt: true },
    });
    expect(mockSignProfileImageUrl).toHaveBeenCalledWith(SESSION_USER);
  });

  it('refuses a session with no user rather than calling it "no picture"', async () => {
    // A session with no `user` is the only way to reach this branch. It used to
    // answer `{ url: null }`, which is the same thing this procedure says about
    // a user who simply has not uploaded anything - so a broken session was
    // indistinguishable from an empty avatar.
    //
    // `{ url: null }` is still the answer for
    // every *successful* lookup that finds no object, which is the case that
    // had to stay cacheable.
    const caller = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(caller.user.getPresignedDownloadUrl({})).rejects.toMatchObject(
      { code: "UNAUTHORIZED" },
    );

    expect(mockUserFindUnique).not.toHaveBeenCalled();
    expect(mockSignProfileImageUrl).not.toHaveBeenCalled();
  });

  it("still resolves { url: null } for a real user with no picture", async () => {
    // The positive control for the test above: the cacheable shape has to
    // survive the change that made a broken session throw.
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

    expect(mockSignProfileImageUrl).not.toHaveBeenCalled();
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

    expect(mockSignProfileImageUrl).not.toHaveBeenCalled();
  });

  it("surfaces a failed lookup as INTERNAL_SERVER_ERROR", async () => {
    // The column read is the only thing here that can throw: signing catches
    // its own failures and resolves null.
    mockUserFindUnique.mockRejectedValueOnce(new Error("database exploded"));
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
 * Upload constraints for `user.getPresignedUrl`.
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
/**
 * The recorded picture timestamp is the only answer to "has a picture?".
 *
 * It used to be one of two: a null column fell back to an S3 `HeadObject`,
 * because every row predating the column was null whether or not an object
 * existed (SCRUM-276). The backfill recorded all of those, so a null column now
 * means "no picture" and resolves `{ url: null }` without signing (SCRUM-366).
 * Signing is a local HMAC, so no path here makes an S3 request - pinned
 * against the real module in `uploadToS3.test.ts`.
 *
 * The half that still matters most is the negative one: nothing that is not a
 * recorded timestamp may produce a signed URL, because signing for an object
 * nobody uploaded shows a broken image instead of the fallback icon.
 */
/**
 * SCRUM-508: `role: carpoolSearch?.role ?? Role.VIEWER` collapses two
 * different situations into the same value - a user who has never had a
 * `CarpoolSearch` row, and a returning user whose row genuinely stores
 * VIEWER. `hasCarpoolSearch` is what lets a caller (the onboarding wizard)
 * tell them apart; these pin the merge site that produces it.
 */
describe("user.me — hasCarpoolSearch", () => {
  it("reports hasCarpoolSearch: false, with the VIEWER fallback, for a user with no CarpoolSearch row", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: SESSION_USER,
      carpoolSearches: [],
    });

    const result = await callerFor(sessionFor(SESSION_USER)).user.me();

    expect(result.hasCarpoolSearch).toBe(false);
    expect(result.role).toBe(Role.VIEWER);
  });

  it("reports hasCarpoolSearch: true, with the stored role, for a returning user who chose VIEWER", async () => {
    mockUserFindUnique.mockResolvedValueOnce({
      id: SESSION_USER,
      carpoolSearches: [
        {
          role: Role.VIEWER,
          status: Status.ACTIVE,
          seatsAvail: 0,
          companyName: "",
          daysWorking: "",
          startTime: null,
          endTime: null,
          startDate: null,
          endDate: null,
          groupNotes: null,
          groupMusicPreference: null,
          groupConversationStyle: null,
          carpoolId: null,
          homeLocation: null,
          companyLocation: null,
        },
      ],
    });

    const result = await callerFor(sessionFor(SESSION_USER)).user.me();

    expect(result.hasCarpoolSearch).toBe(true);
    expect(result.role).toBe(Role.VIEWER);
  });
});

describe("user.getPresignedDownloadUrl — recorded picture state", () => {
  it("signs without any S3 call once an upload has been recorded", async () => {
    mockUserFindUnique.mockResolvedValue({
      profilePictureUpdatedAt: new Date("2026-09-03T12:00:00Z"),
    });
    mockSignProfileImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).resolves.toEqual({ url: SIGNED });

    expect(mockSignProfileImageUrl).toHaveBeenCalledWith(OTHER_USER);
  });

  it("reads the state of the user being asked about, not the caller", async () => {
    mockUserFindUnique.mockResolvedValue({
      profilePictureUpdatedAt: new Date("2026-09-03T12:00:00Z"),
    });
    mockSignProfileImageUrl.mockResolvedValueOnce(SIGNED);
    const caller = callerFor(sessionFor(SESSION_USER));

    await caller.user.getPresignedDownloadUrl({ userId: OTHER_USER });

    // Keying this off the session would answer for the wrong person: a caller
    // with a picture would get a signed URL for every avatar on the page.
    expect(mockUserFindUnique).toHaveBeenCalledWith({
      where: { id: OTHER_USER },
      select: { profilePictureUpdatedAt: true },
    });
  });

  it("returns { url: null } without signing when nothing has been recorded", async () => {
    // Was the S3 fallback until the backfill ran everywhere. A null column is
    // now a user who has never uploaded a picture, which is most of them.
    mockUserFindUnique.mockResolvedValue({ profilePictureUpdatedAt: null });
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).resolves.toEqual({ url: null });

    expect(mockSignProfileImageUrl).not.toHaveBeenCalled();
  });

  it("returns { url: null } without signing for a user row that does not exist", async () => {
    // `findUnique` resolves null, so the procedure reads
    // `owner?.profilePictureUpdatedAt` as undefined. Signing on that would
    // hand out a URL for an object nobody uploaded.
    mockUserFindUnique.mockResolvedValue(null);
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(
      caller.user.getPresignedDownloadUrl({ userId: OTHER_USER }),
    ).resolves.toEqual({ url: null });

    expect(mockSignProfileImageUrl).not.toHaveBeenCalled();
  });

  it("still resolves { url: null } rather than undefined on the signing path", async () => {
    // The cacheability contract has to survive the new branch: a
    // signing failure is a successful lookup that found nothing renderable.
    mockUserFindUnique.mockResolvedValue({
      profilePictureUpdatedAt: new Date("2026-09-03T12:00:00Z"),
    });
    mockSignProfileImageUrl.mockResolvedValueOnce(null);
    const caller = callerFor(sessionFor(SESSION_USER));

    const result = await caller.user.getPresignedDownloadUrl({
      userId: OTHER_USER,
    });

    expect(result).not.toBeUndefined();
    expect(result).toEqual({ url: null });
  });
});

/**
 * `user.recordProfilePictureUpload`.
 *
 * The client PUTs straight to S3, so this is the only thing that tells the
 * server a picture exists. Two properties are worth pinning: it writes for the
 * session user and nobody else, and it takes no input that could redirect it.
 */
describe("user.recordProfilePictureUpload", () => {
  it("records the upload against the session user", async () => {
    const caller = callerFor(sessionFor(SESSION_USER));

    await expect(caller.user.recordProfilePictureUpload()).resolves.toEqual({
      success: true,
    });

    expect(mockUserUpdate).toHaveBeenCalledTimes(1);
    const call = mockUserUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: { profilePictureUpdatedAt: Date };
    };
    expect(call.where).toEqual({ id: SESSION_USER });
    expect(call.data.profilePictureUpdatedAt).toBeInstanceOf(Date);
  });

  it("refuses a session with no user", async () => {
    const caller = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
    } as unknown as Session);

    await expect(
      caller.user.recordProfilePictureUpload(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("is rejected without a session at all", async () => {
    await expect(
      callerFor(null).user.recordProfilePictureUpload(),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("writes a fresh timestamp on a replacement, keeping the column accurate", async () => {
    // The acceptance criterion about replacing a picture. There is no delete
    // path in the app, so replacement is the only way the value changes after
    // the first upload.
    const caller = callerFor(sessionFor(SESSION_USER));

    await caller.user.recordProfilePictureUpload();
    await caller.user.recordProfilePictureUpload();

    expect(mockUserUpdate).toHaveBeenCalledTimes(2);
    const [first, second] = mockUserUpdate.mock.calls.map(
      (call) =>
        (call[0] as { data: { profilePictureUpdatedAt: Date } }).data
          .profilePictureUpdatedAt,
    );
    // Never null, and never carried over from the previous call.
    expect(first).toBeInstanceOf(Date);
    expect(second).toBeInstanceOf(Date);
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});

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
 * End-to-end wiring for Location ownership in `user.edit`.
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
  /** Only the group guard reads these. */
  role?: Role;
  carpoolId?: string | null;
  /** Written by `user.edit`, and asserted on by the schedule-time tests. */
  startTime?: Date | null;
  endTime?: Date | null;
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
  // one transaction, so the mock rolls back on a throw. `created`
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
 * The input issues a refused `user.edit` carries, as `{ path, message }`.
 *
 * Read off `cause` because the procedure's message is the serialised list,
 * which is not something to assert against. Throws if the call resolved, so a
 * validation that stopped firing fails loudly rather than as an empty list.
 */
const editIssues = async (
  call: Promise<unknown>,
): Promise<{ path: PropertyKey[]; message: string }[]> => {
  const error = await call.then(
    () => {
      throw new Error("expected user.edit to refuse this input");
    },
    (rejection: unknown) => rejection,
  );

  expect(error).toBeInstanceOf(TRPCError);
  const issues = (
    (error as TRPCError).cause as unknown as {
      issues?: { path: PropertyKey[]; message: string }[];
    }
  )?.issues;
  if (!issues) {
    throw new Error("user.edit refused the input without zod issues");
  }
  return issues.map(({ path, message }) => ({ path: [...path], message }));
};

/**
 * Terms acceptance is recorded by `user.acceptTerms` and by nothing else.
 * It used to be set to `true` by every profile save, which made
 * `licenseSigned` a record of "this user saved a profile" rather than of consent
 * to a liability disclaimer written on behalf of the university.
 *
 * It now records *when* and *to what* as well, and all three columns move
 * together. A row with the boolean set and the other two null is not a partial
 * write from here - it is a row that predates the columns, and the only thing
 * that distinguishes the untrusted legacy cohort. SCRUM-280.
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
      data: {
        licenseSigned: true,
        licenseSignedAt: expect.any(Date),
        licenseVersion: CURRENT_TERMS_VERSION,
      },
    });
  });

  it("stamps the version the server is serving, not one a caller chose", async () => {
    // `acceptTerms` takes no input at all, which is what makes the stored
    // version evidence rather than a claim. Pinned because adding a `version`
    // parameter would look harmless and would let a stale or hostile client
    // record agreement to wording it never displayed.
    const update = jest.fn(async ({ where }: any) => ({ id: where.id }));

    await (
      acceptCallerFor(sessionFor(SESSION_USER), {
        user: { update },
      }).user.acceptTerms as (input?: unknown) => Promise<unknown>
    )({ licenseVersion: "1999-01-01" });

    expect(update.mock.calls[0][0].data.licenseVersion).toBe(
      CURRENT_TERMS_VERSION,
    );
  });

  it("writes a timestamp at the moment of acceptance", async () => {
    const update = jest.fn(async ({ where }: any) => ({ id: where.id }));

    const before = Date.now();
    await acceptCallerFor(sessionFor(SESSION_USER), {
      user: { update },
    }).user.acceptTerms();
    const after = Date.now();

    const signedAt: Date = update.mock.calls[0][0].data.licenseSignedAt;
    expect(signedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(signedAt.getTime()).toBeLessThanOrEqual(after);
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
      data: {
        licenseSigned: true,
        licenseSignedAt: expect.any(Date),
        licenseVersion: CURRENT_TERMS_VERSION,
      },
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

describe("user.edit — terms acceptance is not a profile field", () => {
  it("never writes licenseSigned, even when a client sends it", async () => {
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    // An older client would still send this; Zod strips it and the resolver no
    // longer reads it, so a stale bundle cannot flip the flag.
    await caller.user.edit(editInput({ licenseSigned: true }));

    expect(db.prisma.user.update).toHaveBeenCalled();
    for (const call of db.prisma.user.update.mock.calls) {
      expect((call[0] as any).data).not.toHaveProperty("licenseSigned");
      expect((call[0] as any).data).not.toHaveProperty("licenseSignedAt");
      expect((call[0] as any).data).not.toHaveProperty("licenseVersion");
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
 * A first-time save that loses the race to create the user's only
 * CarpoolSearch (SCRUM-544).
 *
 * The race itself, and the unique index that decides it, only exist against a
 * real MySQL - `user.db.test.ts` has those. What this covers is the router's
 * half: which refusal it retries, and that it retries the whole save once.
 */
describe("user.edit — losing the first-save race", () => {
  /** A P2002, with `meta.target` as MySQL (a string) or others (fields) report it. */
  const uniqueViolation = (target: string | string[]) =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { target },
    });

  /** Locations belonging to the save that won, committed by the time it lost. */
  const WINNER_LOCATIONS: LocationRow[] = [
    {
      id: "loc-winner-home",
      street: "Elm St",
      city: "Somerville",
      state: "Massachusetts",
      streetAddress: "Elm St, Somerville, Massachusetts",
      coordLng: -71.12,
      coordLat: 42.39,
    },
    {
      id: "loc-winner-company",
      street: "Main St",
      city: "Cambridge",
      state: "Massachusetts",
      streetAddress: "Main St, Cambridge, Massachusetts",
      coordLng: -71.09,
      coordLat: 42.36,
    },
  ];

  /**
   * The first `create` is refused with `refusal`, and the winner's search
   * commits while this save's attempt is rolling back - the order a real lost
   * race has.
   */
  const losingDb = (refusal: Error) => {
    const db = buildEditDb(WINNER_LOCATIONS);
    const { create } = db.prisma.carpoolSearch;
    const commitWinner = create.getMockImplementation()!;
    create.mockImplementationOnce(async () => {
      throw refusal;
    });

    const attempt = db.prisma.$transaction;
    const transaction = jest.fn(async (fn: Parameters<typeof attempt>[0]) => {
      try {
        return await attempt(fn);
      } catch (error) {
        await commitWinner({
          data: {
            userId: SESSION_USER,
            homeLocationId: "loc-winner-home",
            companyLocationId: "loc-winner-company",
          },
        });
        throw error;
      }
    });
    db.prisma.$transaction = transaction as typeof attempt;
    return { db, transaction };
  };

  it.each([
    ["the index name", "carpool_search_userId_key"],
    ["the field list", ["userId"]],
  ])(
    "retries on %s, and the retry updates the winner's search",
    async (_label, target) => {
      const { db, transaction } = losingDb(uniqueViolation(target));

      await editCallerFor(SESSION_USER, db).user.edit(editInput());

      expect(transaction).toHaveBeenCalledTimes(2);
      // One search - the winner's row - now holding this save's values.
      const search = db.searchFor(SESSION_USER);
      expect(search?.homeLocationId).toBe("loc-winner-home");
      expect(search).toMatchObject({ companyName: "Acme" });
      expect(db.homeOf(SESSION_USER)).toMatchObject({
        coordLng: -71.1,
        coordLat: 42.31,
      });
    },
  );

  it.each([
    ["a unique violation on another index", uniqueViolation("location_key")],
    ["any other error", new Error("connection reset")],
  ])("does not retry %s", async (_label, refusal) => {
    const { db, transaction } = losingDb(refusal);

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(editInput()),
    ).rejects.toMatchObject({ cause: refusal });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

/**
 * `user.edit` writes four `VARCHAR(191)` columns — `user.bio`,
 * `user.preferred_name`, `user.pronouns` and `carpool_search.company_name` —
 * and every one of them arrived as an unbounded `z.string()`.
 * MySQL runs in strict mode, so an oversized value failed the whole profile
 * save inside Prisma rather than being refused at the boundary.
 */
/**
 * Clearing a schedule time.
 *
 * `startTime`/`endTime` are nullable columns with a `NO_SCHEDULE_TIME`
 * placeholder in the display layer, and no code path could write `NULL` to
 * them. The input was `z.optional(z.string())` and the conversion was a truthy
 * ternary, so a cleared time became `undefined` - which **Prisma reads in an
 * `update` as "omit this field"**. A VIEWER emptying their schedule got a
 * success toast and kept the old values.
 *
 * These assertions are about the *payload handed to Prisma*, not the return
 * value, and deliberately so: the mock accepts `undefined` as readily as
 * `null`, so a test that only checked the result would pass either way.
 */
describe("user.edit — a schedule time can be cleared", () => {
  /**
   * An existing `CarpoolSearch` for the caller, so `user.edit` takes its
   * `update` path. With no seeded search it would `create` instead, and
   * `create` has no "omit this field" semantics to test - the whole point here
   * is what `update` receives.
   */
  const withExistingSearch = () =>
    buildEditDb(
      [
        {
          id: "loc-mine-home",
          street: "Huntington Ave",
          city: "Boston",
          state: "Massachusetts",
          streetAddress: "Huntington Ave, Boston, Massachusetts",
          coordLng: -71.1,
          coordLat: 42.31,
        },
        {
          id: "loc-mine-company",
          street: "Congress St",
          city: "Boston",
          state: "Massachusetts",
          streetAddress: "Congress St, Boston, Massachusetts",
          coordLng: -71.05,
          coordLat: 42.36,
        },
      ],
      [
        {
          id: "search-mine",
          userId: SESSION_USER,
          homeLocationId: "loc-mine-home",
          companyLocationId: "loc-mine-company",
          startTime: new Date("1970-01-01T13:00:00.000Z"),
          endTime: new Date("1970-01-01T22:00:00.000Z"),
        },
      ],
    );

  const dataFor = (db: ReturnType<typeof buildEditDb>) =>
    db.prisma.carpoolSearch.update.mock.calls[0][0].data;

  it("writes null when a VIEWER clears both times", async () => {
    const db = withExistingSearch();
    const caller = editCallerFor(SESSION_USER, db);

    await caller.user.edit(
      editInput({ role: Role.VIEWER, startTime: null, endTime: null }),
    );

    const data = dataFor(db);
    expect(data.startTime).toBeNull();
    expect(data.endTime).toBeNull();
  });

  it("omits the field entirely when a time is not supplied", async () => {
    // The `undefined` path has to keep working: the column is genuinely
    // optional, and every caller not editing the schedule sends nothing.
    // `toHaveProperty` is the assertion that distinguishes absent from null -
    // `data.startTime === undefined` would pass for either.
    const db = withExistingSearch();
    const caller = editCallerFor(SESSION_USER, db);

    await caller.user.edit(editInput({ role: Role.VIEWER }));

    const data = dataFor(db);
    expect(data.startTime).toBeUndefined();
    expect(data.endTime).toBeUndefined();
  });

  it("stores the parsed instant when a time is supplied", async () => {
    const db = withExistingSearch();
    const caller = editCallerFor(SESSION_USER, db);

    await caller.user.edit(
      editInput({ startTime: "1970-01-01T14:00:00.000Z" }),
    );

    expect(dataFor(db).startTime).toEqual(new Date("1970-01-01T14:00:00.000Z"));
  });

  it("refuses a non-VIEWER clearing a time, writing nothing", async () => {
    // `onboardSchema` already refuses this in the form; enforced here so a
    // stale or hand-rolled client gets the same answer. The recorded decision
    // for this ticket: only a VIEWER may have no schedule.
    for (const field of ["startTime", "endTime"] as const) {
      const db = buildEditDb();
      const caller = editCallerFor(SESSION_USER, db);

      await expect(
        caller.user.edit(editInput({ role: Role.DRIVER, [field]: null })),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(db.prisma.carpoolSearch.update).not.toHaveBeenCalled();
      expect(db.prisma.carpoolSearch.create).not.toHaveBeenCalled();
    }
  });

  it("still lets a non-VIEWER omit the times", async () => {
    // The refusal must be about an explicit null, not about absence, or every
    // save that does not touch the schedule would start failing.
    const db = buildEditDb();
    const caller = editCallerFor(SESSION_USER, db);

    await expect(
      caller.user.edit(editInput({ role: Role.DRIVER })),
    ).resolves.not.toThrow();
  });
});

describe("user.edit — profile text is bounded by its columns", () => {
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
 * database, and it range-checked neither.
 *
 * Nothing downstream catches either one. `coord_lat` / `coord_lng` are plain
 * `Float`, `start_date` / `end_date` are independent `Date`, so the save
 * succeeds and the row is then quietly excluded from the searches it should
 * appear in - no error anywhere, at any layer.
 *
 * The assertions are all "and writes nothing": the value being refused matters
 * less than the refusal happening before the transaction opens.
 */
describe("user.edit - coordinates are range-checked", () => {
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

describe("user.edit - unresolved coordinates are refused", () => {
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

describe("user.edit - co-op dates must run forwards", () => {
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

  it("exempts a VIEWER, whose save re-sends a range they cannot edit", async () => {
    // SCRUM-551: both pickers are disabled for a VIEWER, so refusing their
    // stored range would reject every save they make, whatever they changed.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          role: Role.VIEWER,
          seatAvail: 0,
          coopStartDate: day("2027-01-31"),
          coopEndDate: day("2026-01-31"),
        }),
      ),
    ).resolves.toBeDefined();
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

  it("still refuses a plausible reversed range, independently of the year bound", async () => {
    // Regression: both checks touch the same two fields. This range is inside
    // the year bound, so the ordering check alone must refuse it.
    const db = buildEditDb();

    const issues = await editIssues(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day("2027-01-31"),
          coopEndDate: day("2026-01-31"),
        }),
      ),
    );

    expect(issues).toEqual([
      { path: ["coopEndDate"], message: COOP_DATE_ORDER_MESSAGE },
    ]);
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
 * A range like 1901→1908 runs forwards, so the ordering check above passed it,
 * and production holds 22 (SCRUM-550). The procedure reads the real clock, so
 * the ceiling edge is computed from `coopYearBounds` rather than written down.
 */
describe("user.edit - co-op years must be plausible", () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const { earliest, latest } = coopYearBounds();

  it("refuses production's commonest shape on both dates, writing nothing", async () => {
    const db = buildEditDb();

    const issues = await editIssues(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day("1901-01-31"),
          coopEndDate: day("1908-06-30"),
        }),
      ),
    );

    expect(issues).toEqual([
      { path: ["coopStartDate"], message: coopYearMessage() },
      { path: ["coopEndDate"], message: coopYearMessage() },
    ]);
    expect(db.prisma.user.update).not.toHaveBeenCalled();
    expect(db.prisma.carpoolSearch.create).not.toHaveBeenCalled();
  });

  it.each([
    ["the last day before the floor", `${earliest - 1}-12-31`, "2026-06-30"],
    ["the first month past the ceiling", "2026-01-31", `${latest + 1}-01-31`],
  ])("refuses %s", async (_name, start, end) => {
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({ coopStartDate: day(start), coopEndDate: day(end) }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.prisma.user.update).not.toHaveBeenCalled();
  });

  it("accepts a range spanning exactly the bound", async () => {
    // A year bound's failure mode is refusing a real co-op.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day(`${earliest}-01-31`),
          coopEndDate: day(`${latest}-12-31`),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("exempts a VIEWER, whose save re-sends dates they cannot edit", async () => {
    // Refusing a VIEWER's stored year would reject every save they make.
    const db = buildEditDb();

    await expect(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          role: Role.VIEWER,
          seatAvail: 0,
          coopStartDate: day("1901-01-31"),
          coopEndDate: day("1906-06-30"),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("reports both checks for a range that is absurd and reversed", async () => {
    // Production's 1913 → 1907 row trips both predicates; neither hides the
    // other.
    const db = buildEditDb();

    const issues = await editIssues(
      editCallerFor(SESSION_USER, db).user.edit(
        editInput({
          coopStartDate: day("1913-01-31"),
          coopEndDate: day("1907-06-30"),
        }),
      ),
    );

    expect(issues).toEqual([
      { path: ["coopStartDate"], message: coopYearMessage() },
      { path: ["coopEndDate"], message: coopYearMessage() },
      { path: ["coopEndDate"], message: COOP_DATE_ORDER_MESSAGE },
    ]);
  });
});

/**
 * Atomicity of `user.edit`.
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
 * A driver in a carpool group cannot change role out of it.
 *
 * This was once a `toast.error` in the profile page; the profile
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
describe("user.edit — a driver in a group cannot change role", () => {
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

/**
 * The server half of the fix's contract: `user.edit` stores the schedule time
 * the client sent and does not reinterpret it.
 *
 * The offset can only be chosen where the wall clock is known, which is the
 * picker — `toStoredScheduleTime` anchors it there. The router therefore has
 * exactly one job, to parse the ISO string through unchanged, and these pin
 * that. A well-meaning conversion added here later would silently reintroduce
 * the seasonal drift, and nothing else in the suite would notice.
 */
describe("user.edit — schedule times", () => {
  const savedOn = (day: string, wallClock: string): Date => {
    const stored = toStoredScheduleTime(
      dayjs.tz(`${day} ${wallClock}`, SCHEDULE_TIMEZONE),
    );

    if (!stored) {
      throw new Error(`could not build a schedule time for ${wallClock}`);
    }

    return stored;
  };

  it("stores the anchored value the client sent, unchanged", async () => {
    const db = buildEditDb();
    const startTime = savedOn("2026-07-15", "09:00");
    const endTime = savedOn("2026-07-15", "17:00");

    await editCallerFor(SESSION_USER, db).user.edit(
      editInput({
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }),
    );

    expect(db.searchFor(SESSION_USER)?.startTime).toEqual(startTime);
    expect(db.searchFor(SESSION_USER)?.endTime).toEqual(endTime);
  });

  it("stores one value for one wall clock, whichever season it was picked in", async () => {
    // The same 9:00 AM, submitted by a client that picked it in July and by one
    // that picked it in January. Before the fix these arrived as different
    // instants and were stored as different times.
    const summer = buildEditDb();
    const winter = buildEditDb();

    await editCallerFor(SESSION_USER, summer).user.edit(
      editInput({ startTime: savedOn("2026-07-15", "09:00").toISOString() }),
    );
    await editCallerFor(SESSION_USER, winter).user.edit(
      editInput({ startTime: savedOn("2026-01-15", "09:00").toISOString() }),
    );

    expect(summer.searchFor(SESSION_USER)?.startTime).toEqual(
      winter.searchFor(SESSION_USER)?.startTime,
    );
  });

  it("leaves the columns alone when the client sends no times", async () => {
    // Both are nullable and the profile form allows a partial save.
    const db = buildEditDb();

    await editCallerFor(SESSION_USER, db).user.edit(editInput());

    expect(db.searchFor(SESSION_USER)?.startTime).toBeUndefined();
  });
});
