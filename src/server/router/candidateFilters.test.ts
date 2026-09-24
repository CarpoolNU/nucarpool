import { Permission, Role, Status } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";
import { fakeBlockDelegate } from "../../testing/blockFake";

/**
 * Router-level coverage for the two endpoints that drive the explore page:
 * `user.recommendations.me` and `mapbox.geoJsonUserList`.
 *
 * Both build their candidate query from relations pulled in through a
 * *conditional* include - `favorites: input.filters.favorites`. Prisma omits
 * such a key entirely when the value is false, so it arrives as `undefined`
 * rather than `[]`, and `favorites.map(...)` was left outside the guard
 * that protects the equivalent `sentRequests` call. Every default page load
 * (`favorites: false`) threw a TypeError and returned INTERNAL_SERVER_ERROR.
 *
 * Neither endpoint had a test file, and `candidateSearch.test.ts` covers only
 * the pure helpers with mocks that hand back arrays where the real client hands
 * back `undefined` - which is precisely why all six CI checks passed on a total
 * outage of the primary screen. So the Prisma double below deliberately models
 * the omission (see `applyInclude`); a mock that returned `[]` here would pass
 * against the broken code and pin nothing.
 *
 * These drive the real `appRouter` through `createCaller`, following
 * `user/favorites.test.ts` and `authorization.test.ts`. No database, no Mapbox
 * call - `geoJsonUserList` queries Prisma and does its own GeoJSON assembly, so
 * it never reaches the network.
 */

const USER_ID = "me";
const FAVORITE_A = "favorite-a";
const FAVORITE_B = "favorite-b";
const MESSAGED_TO = "messaged-to";
const MESSAGED_FROM = "messaged-from";
const BLOCKED_BY_ME = "blocked-by-me";
const BLOCKED_ME = "blocked-me";
const BYSTANDER = "bystander";

const session: Session = {
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id: USER_ID,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
};

const BOSTON = { coordLat: 42.34, coordLng: -71.09 };

/**
 * Applies a Prisma `include` to a full row the way the client does: a key whose
 * include value is falsy is **absent** from the result, not empty.
 *
 * This is the contract the bug hinged on, so it is modelled rather than
 * assumed. `relations` holds every relation the row could carry; only those the
 * include asks for are copied onto the returned object.
 */
const applyInclude = (
  row: Record<string, unknown>,
  relations: Record<string, unknown>,
  include: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...row };

  for (const [key, value] of Object.entries(relations)) {
    if (include?.[key]) {
      result[key] = value;
    }
  }

  return result;
};

/**
 * A Prisma double for the one read each endpoint makes plus the candidate
 * query. `findMany` returns no candidates: what these tests pin is that the
 * procedure completes and that the `where` it built applies the favorites
 * filter correctly. Scoring and ranking are already covered by
 * `candidateSearch.test.ts` and `recommendation.test.ts`.
 */
const buildPrisma = () => {
  const findMany = jest.fn(async (_args: any): Promise<unknown[]> => []);

  const findFirst = jest.fn(async ({ include }: any) => {
    const search = {
      id: "search-1",
      userId: USER_ID,
      role: Role.RIDER,
      status: Status.ACTIVE,
      carpoolId: null,
      seatsAvail: 0,
      daysWorking: "0,1,1,1,1,1,0",
      startTime: null,
      endTime: null,
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-06-01T00:00:00.000Z"),
      homeLocation: { ...BOSTON },
      companyLocation: { ...BOSTON },
    };

    const user = applyInclude(
      { id: USER_ID, isOnboarded: true },
      {
        favorites: [{ id: FAVORITE_A }, { id: FAVORITE_B }],
        sentRequests: [{ toUserId: MESSAGED_TO }],
        receivedRequests: [{ fromUserId: MESSAGED_FROM }],
      },
      include?.user?.include,
    );

    return { ...search, user };
  });

  // No blocks by default, which is what every test above the block section
  // was written against.
  const block = fakeBlockDelegate();

  return {
    prisma: { carpoolSearch: { findFirst, findMany }, block },
    /** Live block rows: push to block, splice to unblock. */
    blocks: block.rows,
    /** The `where` the candidate query was built with. */
    candidateWhere: (): any => findMany.mock.calls[0]?.[0]?.where,
    findFirst,
    findMany,
  };
};

const caller = (prisma: unknown) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

/** The default explore-page filter state (`src/pages/index.tsx`). */
const filters = (overrides: Record<string, unknown> = {}) => ({
  days: 0,
  daysWorking: "0,1,1,1,1,1,0",
  flexDays: 0,
  startDistance: 20,
  endDistance: 20,
  startTime: 4,
  endTime: 4,
  startDate: new Date("2026-01-01T00:00:00.000Z"),
  endDate: new Date("2026-06-01T00:00:00.000Z"),
  dateOverlap: 0,
  favorites: false,
  messaged: true,
  ...overrides,
});

describe("the conditional-include contract this bug hinged on", () => {
  it("omits a relation whose include is false, rather than returning []", async () => {
    const { prisma } = buildPrisma();

    const search: any = await prisma.carpoolSearch.findFirst({
      where: { userId: USER_ID },
      include: {
        user: { include: { favorites: false, sentRequests: true } },
      },
    });

    expect(search.user.favorites).toBeUndefined();
    expect("favorites" in search.user).toBe(false);
    // The true include is present, so an absent key really does mean "not asked
    // for" and not "the double forgot to populate it".
    expect(Array.isArray(search.user.sentRequests)).toBe(true);
  });
});

describe.each([
  [
    "user.recommendations.me",
    (prisma: unknown, overrides: Record<string, unknown>) =>
      caller(prisma).user.recommendations.me({
        sort: "distance",
        filters: filters(overrides),
      }),
  ],
  [
    "mapbox.geoJsonUserList",
    (prisma: unknown, overrides: Record<string, unknown>) =>
      caller(prisma).mapbox.geoJsonUserList(filters(overrides) as any),
  ],
])("%s — favorites filter", (_name, call) => {
  it("resolves with the default filter state, where favorites is false", async () => {
    const { prisma } = buildPrisma();

    // The regression: this threw `Cannot read properties of undefined
    // (reading 'map')` and surfaced as INTERNAL_SERVER_ERROR.
    await expect(call(prisma, { favorites: false })).resolves.toBeDefined();
  });

  it("adds no favorites narrowing when the filter is off", async () => {
    const { prisma, candidateWhere } = buildPrisma();

    await call(prisma, { favorites: false });

    expect(candidateWhere().userId.in).toBeUndefined();
  });

  it("resolves and narrows to the caller's favorites when the filter is on", async () => {
    const { prisma, candidateWhere } = buildPrisma();

    await expect(call(prisma, { favorites: true })).resolves.toBeDefined();

    expect(candidateWhere().userId.in).toEqual([FAVORITE_A, FAVORITE_B]);
  });

  it("still excludes messaged users when that filter is on, alongside favorites", async () => {
    const { prisma, candidateWhere } = buildPrisma();

    await expect(
      call(prisma, { favorites: true, messaged: false }),
    ).resolves.toBeDefined();

    const { userId } = candidateWhere();

    expect(userId.in).toEqual([FAVORITE_A, FAVORITE_B]);
    expect(userId.notIn).toEqual([USER_ID, MESSAGED_TO, MESSAGED_FROM]);
  });
});

/**
 * Blocks (SCRUM-554). Both endpoints get their exclusion list from
 * `candidateExclusions`, so these run against each of them: a copy that
 * dropped the block lookup would otherwise pass through the other's tests.
 */
describe.each([
  [
    "user.recommendations.me",
    (prisma: unknown, overrides: Record<string, unknown>) =>
      caller(prisma).user.recommendations.me({
        sort: "distance",
        filters: filters(overrides),
      }),
  ],
  [
    "mapbox.geoJsonUserList",
    (prisma: unknown, overrides: Record<string, unknown>) =>
      caller(prisma).mapbox.geoJsonUserList(filters(overrides) as any),
  ],
])("%s — blocked users are excluded", (_name, call) => {
  /** Blocks in both directions, plus one between two other people. */
  const withBlocks = () => {
    const db = buildPrisma();
    db.blocks.push(
      { blockerId: USER_ID, blockedId: BLOCKED_BY_ME },
      { blockerId: BLOCKED_ME, blockedId: USER_ID },
      // Not the caller's block, so it must not exclude anyone from their view.
      { blockerId: BYSTANDER, blockedId: MESSAGED_TO },
    );
    return db;
  };

  it("excludes both directions, even with the messaged filter showing everyone", async () => {
    // `messaged: true` is the default and excludes nobody on its own, so this
    // is the case where a block rides on nothing else.
    const { prisma, candidateWhere } = withBlocks();

    await call(prisma, { messaged: true });

    expect(candidateWhere().userId.notIn).toEqual([
      USER_ID,
      BLOCKED_BY_ME,
      BLOCKED_ME,
    ]);
  });

  it("does not exclude a user whose only block is with someone else", async () => {
    const { prisma, candidateWhere } = withBlocks();

    await call(prisma, { messaged: true });

    expect(candidateWhere().userId.notIn).not.toContain(BYSTANDER);
    expect(candidateWhere().userId.notIn).not.toContain(MESSAGED_TO);
  });

  it("adds the blocks to the messaged exclusions rather than replacing them", async () => {
    const { prisma, candidateWhere } = withBlocks();

    await call(prisma, { messaged: false });

    expect(candidateWhere().userId.notIn).toEqual([
      USER_ID,
      BLOCKED_BY_ME,
      BLOCKED_ME,
      MESSAGED_TO,
      MESSAGED_FROM,
    ]);
  });

  it("still excludes a blocked favourite when the favorites filter is on", async () => {
    // The favorites narrowing is an `in`; the block has to sit beside it as a
    // `notIn`, or a favourite would bypass it.
    const { prisma, blocks, candidateWhere } = buildPrisma();
    blocks.push({ blockerId: FAVORITE_A, blockedId: USER_ID });

    await call(prisma, { favorites: true });

    expect(candidateWhere().userId.in).toEqual([FAVORITE_A, FAVORITE_B]);
    expect(candidateWhere().userId.notIn).toEqual([USER_ID, FAVORITE_A]);
  });

  it("stops excluding a user once the block is removed", async () => {
    const { prisma, blocks, findMany } = withBlocks();
    const whereOfCall = (n: number): any => findMany.mock.calls[n]?.[0]?.where;

    await call(prisma, { messaged: true });
    blocks.splice(0, blocks.length);
    await call(prisma, { messaged: true });

    expect(whereOfCall(0).userId.notIn).toContain(BLOCKED_ME);
    expect(whereOfCall(1).userId.notIn).toEqual([USER_ID]);
  });
});
