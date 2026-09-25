import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";
import { BLOCK_GROUP_MEMBER_MESSAGE } from "./blocks";

/**
 * `user.blocks` - creating, listing and removing a block (SCRUM-554).
 *
 * What a block *does* is tested at each enforcement site. This file pins the
 * row's own rules: the actor is the session, never the input; self and group
 * members are refused; and both mutations are idempotent.
 *
 * The fake applies `upsert` and `deleteMany` to an in-memory list keyed on the
 * unique pair, so a test can assert the resulting rows rather than only the
 * arguments Prisma was called with.
 */

const ME = "user-me";
const THEM = "user-them";
const OTHER = "user-other";

type Row = { blockerId: string; blockedId: string; dateCreated: Date };

const buildBlocksDb = (opts?: {
  rows?: Row[];
  users?: Record<string, { preferredName: string; name: string | null }>;
  carpoolIds?: Record<string, string | null>;
}) => {
  const rows: Row[] = opts?.rows ?? [];
  const users = opts?.users ?? {
    [ME]: { preferredName: "Me", name: "Me Full" },
    [THEM]: { preferredName: "Them", name: "Them Full" },
    [OTHER]: { preferredName: "", name: "Other Full" },
  };
  const carpoolIds = opts?.carpoolIds ?? {};

  const client = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        users[where.id] ? { id: where.id } : null,
      ),
    },
    // `applyBlock`'s group-membership check is a locking `$queryRaw`
    // (SCRUM-566), not `carpoolSearch.findMany` - always exactly two
    // interpolated values, `blockerId` then `blockedId`.
    $queryRaw: jest.fn(async (_strings: unknown, ...values: unknown[]) => {
      const [blockerId, blockedId] = values as [string, string];
      return [blockerId, blockedId]
        .filter((id) => id in carpoolIds)
        .map((userId) => ({ userId, carpoolId: carpoolIds[userId] }));
    }),
    block: {
      findMany: jest.fn(async ({ where }: any) =>
        rows
          .filter((row) => row.blockerId === where.blockerId)
          .sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime())
          .map((row) => ({
            blockedId: row.blockedId,
            dateCreated: row.dateCreated,
            blocked: users[row.blockedId],
          })),
      ),
      upsert: jest.fn(async ({ where, create }: any) => {
        const { blockerId, blockedId } = where.blockerId_blockedId;
        const existing = rows.find(
          (row) => row.blockerId === blockerId && row.blockedId === blockedId,
        );
        if (existing) return existing;
        const row = { ...create, dateCreated: new Date() };
        rows.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (
            rows[i].blockerId === where.blockerId &&
            rows[i].blockedId === where.blockedId
          ) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      }),
    },
  };

  // `user.blocks.block` now runs `applyBlock` inside an explicit transaction
  // (SCRUM-566), so the fake has to support one. Nothing here needs
  // rollback: every refusal in `applyBlock` throws before its one write, the
  // upsert above. `enumerable: false`, the same as `reports.test.ts`'s
  // equivalent fake, so a `{ ...prisma }` spread would not carry it along.
  const prisma = Object.defineProperty({ ...client }, "$transaction", {
    value: jest.fn(async (fn: (tx: typeof client) => Promise<unknown>) =>
      fn(client),
    ),
    enumerable: false,
  });

  return { prisma, rows };
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

const callerFor = (session: Session | null, db = buildBlocksDb()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db };
};

const pairs = (rows: Row[]) =>
  rows.map((row) => `${row.blockerId}->${row.blockedId}`);

describe("user.blocks.block", () => {
  it("records the session user as the blocker", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(caller.user.blocks.block({ userId: THEM })).resolves.toEqual({
      blocked: true,
    });
    expect(pairs(db.rows)).toEqual([`${ME}->${THEM}`]);
  });

  it("rejects a blocker named in the input", async () => {
    // `.strict()`: the acting user cannot be chosen by the client.
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.blocks.block({ userId: THEM, blockerId: OTHER } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.rows).toEqual([]);
  });

  it("is idempotent", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await caller.user.blocks.block({ userId: THEM });
    await caller.user.blocks.block({ userId: THEM });

    expect(pairs(db.rows)).toEqual([`${ME}->${THEM}`]);
  });

  it("refuses to block yourself", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.blocks.block({ userId: ME }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.rows).toEqual([]);
  });

  it("refuses a user that does not exist", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.blocks.block({ userId: "no-such-user" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.rows).toEqual([]);
  });

  it("refuses someone in the caller's own group, with Leave the group first", async () => {
    const db = buildBlocksDb({
      carpoolIds: { [ME]: "group-1", [THEM]: "group-1" },
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(
      caller.user.blocks.block({ userId: THEM }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: BLOCK_GROUP_MEMBER_MESSAGE,
    });
    expect(BLOCK_GROUP_MEMBER_MESSAGE).toMatch(/^Leave the group first/);
    expect(db.rows).toEqual([]);
  });

  it.each([
    ["both ungrouped", { [ME]: null, [THEM]: null }],
    ["in different groups", { [ME]: "group-1", [THEM]: "group-2" }],
    ["only the caller grouped", { [ME]: "group-1", [THEM]: null }],
    ["neither has a carpool search", {}],
  ])("allows a block when %s", async (_, carpoolIds) => {
    const db = buildBlocksDb({ carpoolIds });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.blocks.block({ userId: THEM });
    expect(pairs(db.rows)).toEqual([`${ME}->${THEM}`]);
  });

  it("requires a session", async () => {
    const { caller } = callerFor(null);

    await expect(
      caller.user.blocks.block({ userId: THEM }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("user.blocks.unblock", () => {
  it("removes only the caller's own block", async () => {
    const db = buildBlocksDb({
      rows: [
        { blockerId: ME, blockedId: THEM, dateCreated: new Date(1) },
        // THEM's block of ME is theirs to lift, not mine.
        { blockerId: THEM, blockedId: ME, dateCreated: new Date(2) },
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.blocks.unblock({ userId: THEM });

    expect(pairs(db.rows)).toEqual([`${THEM}->${ME}`]);
  });

  it("is idempotent", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(caller.user.blocks.unblock({ userId: THEM })).resolves.toEqual(
      { blocked: false },
    );
    expect(db.rows).toEqual([]);
  });
});

describe("user.blocks.me", () => {
  it("lists the people the caller blocked, newest first, and not who blocked them", async () => {
    const db = buildBlocksDb({
      rows: [
        { blockerId: ME, blockedId: THEM, dateCreated: new Date(1) },
        { blockerId: ME, blockedId: OTHER, dateCreated: new Date(2) },
        { blockerId: THEM, blockedId: ME, dateCreated: new Date(3) },
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const list = await caller.user.blocks.me();

    expect(list).toEqual([
      // `OTHER` has no preferred name, so the account name stands in.
      { userId: OTHER, name: "Other Full", blockedAt: new Date(2) },
      { userId: THEM, name: "Them", blockedAt: new Date(1) },
    ]);
    expect(db.prisma.block.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockerId: ME } }),
    );
  });
});
