import { Permission, Role, Status } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";

/**
 * Authorization tests for `user.favorites.edit`.
 *
 * The mutation used to take the owning `userId` from client input and pass it
 * straight to `prisma.user.update({ where: { id: input.userId } })`, so any
 * signed-in caller could edit anyone else's favorites. These tests pin the
 * fixed behaviour: the owner comes from `ctx.session.user.id` and nothing the
 * client sends can redirect the write.
 *
 * Following `src/server/router/authorization.test.ts`, these drive the real
 * `appRouter` through `createCaller` with a fabricated session and a mocked
 * Prisma client — no database, no new test framework.
 *
 * Unlike that file, the mock is not inert: `user.update` actually applies the
 * `connect`/`disconnect` payload to an in-memory favorites store. That is what
 * lets a test assert the *effect* of the mutation — user A's list changed and
 * user B's did not — rather than only asserting which arguments Prisma was
 * called with. It is a stand-in for a real database, not a substitute for one;
 * see the limitations note at the bottom of this file.
 */

const USER_A = "user-a";
const USER_B = "user-b";
const TARGET = "target-user";

/**
 * A Prisma double whose `user.update` mutates a favorites map, so the tests can
 * read final state. Only `connect` and `disconnect` on `favorites` are
 * supported — the single shape this procedure writes.
 */
const buildFavoritesDb = (
  seed: Record<string, string[]> = { [USER_A]: [], [USER_B]: [] },
) => {
  const favorites = new Map<string, Set<string>>(
    Object.entries(seed).map(([userId, ids]) => [userId, new Set(ids)]),
  );

  const update = jest.fn(async ({ where, data }: any) => {
    const owner = favorites.get(where?.id);

    // Models Prisma rejecting an update whose `where` matches no row. If the
    // resolver ever targets an id that is not a seeded user, the test fails
    // loudly instead of silently writing nowhere.
    if (!owner) {
      throw new Error(`No user row matching where.id=${String(where?.id)}`);
    }

    const connect = data?.favorites?.connect;
    const disconnect = data?.favorites?.disconnect;

    if (connect) owner.add(connect.id);
    if (disconnect) owner.delete(disconnect.id);

    return { id: where.id };
  });

  return {
    prisma: { user: { update } },
    /** Final favorites for a user, sorted so assertions are order-independent. */
    favoritesOf: (userId: string) => [...(favorites.get(userId) ?? [])].sort(),
    update,
  };
};

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (session: Session | null, db = buildFavoritesDb()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db };
};

/**
 * The input type no longer has `userId`, so an attacker-shaped payload cannot
 * be expressed in TypeScript. Casting through `unknown` is how these tests
 * reach past the compiler to exercise what an untrusted HTTP client can
 * actually send — the same trick `authorization.test.ts` uses for an
 * out-of-enum permission.
 */
type EditInput = Parameters<
  ReturnType<typeof appRouter.createCaller>["user"]["favorites"]["edit"]
>[0];

const asEditInput = (payload: Record<string, unknown>) =>
  payload as unknown as EditInput;

describe("user.favorites.edit — owner comes from the session", () => {
  it("adds a favorite to the caller's own list and leaves other users alone", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.favorites.edit({ favoriteId: TARGET, add: true });

    expect(db.favoritesOf(USER_A)).toEqual([TARGET]);
    expect(db.favoritesOf(USER_B)).toEqual([]);
  });

  it("removes a favorite from the caller's own list and leaves other users alone", async () => {
    const db = buildFavoritesDb({ [USER_A]: [TARGET], [USER_B]: [TARGET] });
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.favorites.edit({ favoriteId: TARGET, add: false });

    expect(db.favoritesOf(USER_A)).toEqual([]);
    // B favorited the same person; A's removal must not touch B's list.
    expect(db.favoritesOf(USER_B)).toEqual([TARGET]);
  });

  it("writes against the session user id", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.favorites.edit({ favoriteId: TARGET, add: true });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith({
      where: { id: USER_A },
      data: { favorites: { connect: { id: TARGET } } },
    });
  });

  it("uses the id of whichever user is authenticated, not a fixed one", async () => {
    // Guards against a "fix" that hardcodes an id or reads the wrong session field.
    const { caller, db } = callerFor(sessionFor(USER_B));

    await caller.user.favorites.edit({ favoriteId: TARGET, add: true });

    expect(db.favoritesOf(USER_B)).toEqual([TARGET]);
    expect(db.favoritesOf(USER_A)).toEqual([]);
  });
});

describe("user.favorites.edit — a caller cannot redirect the write", () => {
  it("rejects a payload carrying another user's id instead of honouring it", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.favorites.edit(
        asEditInput({ userId: USER_B, favoriteId: TARGET, add: true }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Rejected at input validation, so nothing was written at all.
    expect(db.update).not.toHaveBeenCalled();
    expect(db.favoritesOf(USER_A)).toEqual([]);
    expect(db.favoritesOf(USER_B)).toEqual([]);
  });

  it("rejects a payload that supplies the caller's own id, because the field is gone", async () => {
    // Even a "harmless" userId is refused: the field must not exist in the
    // contract, or a future resolver could start trusting it again.
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.favorites.edit(
        asEditInput({ userId: USER_A, favoriteId: TARGET, add: true }),
      ),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("never issues a write targeting a user other than the caller", async () => {
    // The property that actually matters, asserted over every call made:
    // whatever the client sends, `where.id` is always the session user.
    const { caller, db } = callerFor(sessionFor(USER_A));

    const payloads = [
      { favoriteId: TARGET, add: true },
      { favoriteId: TARGET, add: false },
      { favoriteId: USER_B, add: true },
    ];

    for (const payload of payloads) {
      await caller.user.favorites.edit(payload);
    }

    expect(db.update).toHaveBeenCalledTimes(payloads.length);
    for (const [{ where }] of db.update.mock.calls as any[]) {
      expect(where.id).toBe(USER_A);
    }
    expect(db.favoritesOf(USER_B)).toEqual([]);
  });
});

describe("user.favorites.edit — authentication gate", () => {
  it("rejects an anonymous caller without touching the database", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.favorites.edit({ favoriteId: TARGET, add: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects a session that carries no user", async () => {
    // protectedRouter only checks that a session exists; the resolver's own
    // guard answers the missing-user case, as `favorites.me` does.
    const { caller, db } = callerFor({
      expires: "2099-01-01T00:00:00.000Z",
      user: undefined,
    } as Session);

    await expect(
      caller.user.favorites.edit({ favoriteId: TARGET, add: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.update).not.toHaveBeenCalled();
  });
});

/**
 * SCRUM-351: `favorites.me` no longer hides a favourite it cannot match.
 *
 * The procedure used to drop any favourite whose role equalled the caller's,
 * whose role was VIEWER, or whose search was INACTIVE — the predicate that
 * belongs in discovery. Applied to a curated list it created a state with no
 * way out: this query is the only source of the favourites list, the
 * un-favourite star lives on the card it renders, and `buildCandidateWhere`
 * narrows the explore map to compatible roles as well. The person disappeared
 * from every surface while their `_Favorites` row persisted.
 *
 * These drive the real `appRouter` with a mocked Prisma, in the style of the
 * `edit` tests above. Nothing here renders a card — see the limitations note at
 * the end of the file.
 */

const CALLER = "caller";

/** A CarpoolSearch row shaped as `convertCarpoolSearchToPublic` expects it. */
const favoriteSearch = (
  id: string,
  over: { role?: Role; status?: Status } = {},
) => ({
  id: `search-${id}`,
  userId: id,
  role: over.role ?? Role.DRIVER,
  status: over.status ?? Status.ACTIVE,
  seatsAvail: 3,
  companyName: "Acme",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  startDate: null,
  endDate: null,
  carpoolId: null,
  user: {
    id,
    name: `${id} name`,
    // Deliberately present on the row the resolver reads, so the assertion that
    // it is absent from the response is testing the converter rather than a
    // fixture that never had one.
    email: `${id}@northeastern.edu`,
    image: null,
    bio: "",
    preferredName: id,
    pronouns: "",
  },
  homeLocation: {
    city: "Boston",
    state: "MA",
    // Chosen so two-decimal coarsening is visible: 42.351234 -> 42.35.
    coordLat: 42.351234,
    coordLng: -71.056789,
  },
  companyLocation: {
    streetAddress: "1 Main St",
    coordLat: 42.4,
    coordLng: -71.1,
  },
});

/**
 * A Prisma double for the three reads `me` performs: the caller's own search
 * (an existence guard), the caller's favorites, and those favourites' searches.
 */
const buildMeDb = ({
  callerRole = Role.RIDER,
  callerSearch = true,
  favorites,
}: {
  callerRole?: Role;
  callerSearch?: boolean;
  favorites: ReturnType<typeof favoriteSearch>[];
}) => {
  const findMany = jest.fn(async () => favorites);

  return {
    prisma: {
      carpoolSearch: {
        findFirst: jest.fn(async () =>
          callerSearch ? { role: callerRole } : null,
        ),
        findMany,
      },
      user: {
        findUnique: jest.fn(async () => ({
          favorites: favorites.map((f) => ({ id: f.userId })),
        })),
        update: jest.fn(),
      },
    },
    findMany,
  };
};

const meCallerFor = (db: ReturnType<typeof buildMeDb>, userId = CALLER) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return appRouter.createCaller(ctx);
};

const idsFrom = async (db: ReturnType<typeof buildMeDb>) =>
  (await meCallerFor(db).user.favorites.me()).map((f) => f.id).sort();

describe("user.favorites.me — a favourite survives becoming unmatchable", () => {
  it("returns a favourite whose role now matches the caller's", async () => {
    // The headline case: a RIDER favourited a DRIVER who has since become a
    // RIDER. Before the fix this returned an empty list.
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [favoriteSearch("same-role", { role: Role.RIDER })],
    });

    expect(await idsFrom(db)).toEqual(["same-role"]);
  });

  it("returns a favourite who has switched to VIEWER", async () => {
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [favoriteSearch("viewer", { role: Role.VIEWER })],
    });

    expect(await idsFrom(db)).toEqual(["viewer"]);
  });

  it("returns a favourite whose search is INACTIVE", async () => {
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [favoriteSearch("paused", { status: Status.INACTIVE })],
    });

    expect(await idsFrom(db)).toEqual(["paused"]);
  });

  it("returns every category at once, keeping the compatible one", async () => {
    // The failure scenario from the ticket: three favourites, two of which
    // drifted. All three have to come back, or the list is still lying.
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [
        favoriteSearch("compatible"),
        favoriteSearch("same-role", { role: Role.RIDER }),
        favoriteSearch("viewer", { role: Role.VIEWER }),
        favoriteSearch("paused", { status: Status.INACTIVE }),
      ],
    });

    expect(await idsFrom(db)).toEqual([
      "compatible",
      "paused",
      "same-role",
      "viewer",
    ]);
  });

  it("is unchanged for an ordinary compatible favourite", async () => {
    const db = buildMeDb({
      callerRole: Role.DRIVER,
      favorites: [favoriteSearch("rider", { role: Role.RIDER })],
    });

    expect(await idsFrom(db)).toEqual(["rider"]);
  });

  it("does not narrow the query by role or status either", async () => {
    // The filter was in JavaScript, so a "fix" that pushed it into SQL would
    // pass every assertion above while reintroducing the bug. The query must
    // select favourites by user id and nothing else.
    const db = buildMeDb({ favorites: [favoriteSearch("rider")] });

    await meCallerFor(db).user.favorites.me();

    const [{ where }] = db.findMany.mock.calls[0] as any[];
    expect(where).toEqual({ userId: { in: ["rider"] } });
  });

  it("still returns an empty list when nothing is favourited", async () => {
    const db = buildMeDb({ favorites: [] });

    expect(await idsFrom(db)).toEqual([]);
  });

  it("still refuses a caller with no CarpoolSearch of their own", async () => {
    // The guard the removed filter's `role` used to be selected for. It is not
    // part of this fix and must not have been dropped with it.
    const db = buildMeDb({ callerSearch: false, favorites: [] });

    await expect(meCallerFor(db).user.favorites.me()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("user.favorites.me — returning more rows must not disclose more", () => {
  it("omits the email address from every entry", async () => {
    // SCRUM-292 removed email from the bulk payloads, favourites among them.
    // Relaxing the row filter must not quietly widen the per-row shape.
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [
        favoriteSearch("compatible"),
        favoriteSearch("same-role", { role: Role.RIDER }),
        favoriteSearch("paused", { status: Status.INACTIVE }),
      ],
    });

    const result = await meCallerFor(db).user.favorites.me();

    expect(result).toHaveLength(3);
    for (const favorite of result) {
      expect(favorite.email).toBeUndefined();
      expect(Object.keys(favorite)).not.toContain("email");
    }
  });

  it("coarsens the home coordinate on the newly-included entries too", async () => {
    // A favourite is not a counterpart, so the coarsened converter applies to
    // them exactly as it does to a compatible favourite.
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [
        favoriteSearch("same-role", { role: Role.RIDER }),
        favoriteSearch("paused", { status: Status.INACTIVE }),
      ],
    });

    const result = await meCallerFor(db).user.favorites.me();

    for (const favorite of result) {
      expect(favorite.startCoordLat).toBe(42.35);
      expect(favorite.startCoordLng).toBe(-71.06);
      // The workplace is not a home and is deliberately not coarsened.
      expect(favorite.companyCoordLat).toBe(42.4);
    }
  });

  it("still carries the role and status the card needs to explain itself", async () => {
    // `ConnectCard` builds its notice from these two fields, so the payload
    // has to keep them for the explanation to be possible at all.
    const db = buildMeDb({
      callerRole: Role.RIDER,
      favorites: [favoriteSearch("paused", { status: Status.INACTIVE })],
    });

    const [favorite] = await meCallerFor(db).user.favorites.me();

    expect(favorite?.role).toBe(Role.DRIVER);
    expect(favorite?.status).toBe(Status.INACTIVE);
  });
});

describe("user.favorites.edit — a newly-visible favourite can be removed", () => {
  it("un-favourites someone whose role change used to hide them", async () => {
    // The point of the whole ticket: the row was unreachable because no card
    // rendered, so no star existed to press. `edit` itself never had a role
    // condition, so once the entry is listed this works - which is what makes
    // relaxing the read filter a complete fix rather than half of one.
    const db = buildFavoritesDb({ [CALLER]: ["same-role"] });
    const { caller } = callerFor(sessionFor(CALLER), db);

    await caller.user.favorites.edit({ favoriteId: "same-role", add: false });

    expect(db.favoritesOf(CALLER)).toEqual([]);
  });
});
