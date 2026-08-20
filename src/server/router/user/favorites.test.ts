import { Permission } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";

/**
 * Authorization tests for `user.favorites.edit` (SCRUM-223).
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
 * see the limitations note at the bottom of this file and SCRUM-263.
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
