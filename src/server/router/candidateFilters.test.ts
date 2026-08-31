import { Permission, Role, Status } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";

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

  return {
    prisma: { carpoolSearch: { findFirst, findMany } },
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
