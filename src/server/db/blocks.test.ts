import { TRPCError } from "@trpc/server";
import {
  BLOCKED_PAIR_MESSAGE,
  assertNotBlocked,
  blockedCounterpartIds,
  isBlockedPair,
  isBlockedWithAny,
} from "./blocks";
import { fakeBlockReader } from "../../testing/blockFake";

/**
 * The block helpers every enforcement site goes through (SCRUM-554).
 *
 * The property under test is symmetry. A `Block` row names one direction, but
 * every helper must answer the same whichever of the pair placed it. A helper
 * reading only `blockerId = me` would let a blocked user keep reaching the
 * person who blocked them, and nothing else in the suite would notice.
 */

const ME = "user-me";
const THEM = "user-them";
const OTHER = "user-other";

const readerWith = (rows: { blockerId: string; blockedId: string }[]) =>
  fakeBlockReader(rows).reader;

describe("blockedCounterpartIds", () => {
  it("is empty when nobody has blocked anybody", async () => {
    expect(await blockedCounterpartIds(readerWith([]), ME)).toEqual([]);
  });

  it("includes both people I blocked and people who blocked me", async () => {
    const prisma = readerWith([
      { blockerId: ME, blockedId: THEM },
      { blockerId: OTHER, blockedId: ME },
      // Not about me, so it must not leak into my list.
      { blockerId: THEM, blockedId: OTHER },
    ]);

    expect((await blockedCounterpartIds(prisma, ME)).sort()).toEqual(
      [OTHER, THEM].sort(),
    );
  });

  it("lists a mutual block once", async () => {
    const prisma = readerWith([
      { blockerId: ME, blockedId: THEM },
      { blockerId: THEM, blockedId: ME },
    ]);

    expect(await blockedCounterpartIds(prisma, ME)).toEqual([THEM]);
  });
});

describe("isBlockedPair", () => {
  it.each([
    ["I blocked them", { blockerId: ME, blockedId: THEM }],
    ["they blocked me", { blockerId: THEM, blockedId: ME }],
  ])("is true when %s", async (_, row) => {
    const prisma = readerWith([row]);

    expect(await isBlockedPair(prisma, ME, THEM)).toBe(true);
    expect(await isBlockedPair(prisma, THEM, ME)).toBe(true);
  });

  it("is false for a pair with no block between them", async () => {
    // A block each of them has with somebody else is not a block between them.
    const prisma = readerWith([
      { blockerId: ME, blockedId: OTHER },
      { blockerId: OTHER, blockedId: THEM },
    ]);

    expect(await isBlockedPair(prisma, ME, THEM)).toBe(false);
  });
});

describe("isBlockedWithAny", () => {
  it("finds a block with any one of several counterparts", async () => {
    const prisma = readerWith([{ blockerId: OTHER, blockedId: ME }]);

    expect(await isBlockedWithAny(prisma, ME, [THEM, OTHER])).toBe(true);
    expect(await isBlockedWithAny(prisma, ME, [THEM])).toBe(false);
  });

  it("reads nothing for an empty list", async () => {
    const { reader, block } = fakeBlockReader([
      { blockerId: ME, blockedId: THEM },
    ]);

    expect(await isBlockedWithAny(reader, ME, [])).toBe(false);
    expect(block.findFirst).not.toHaveBeenCalled();
  });
});

describe("assertNotBlocked", () => {
  it("throws FORBIDDEN with the generic message, in either direction", async () => {
    for (const row of [
      { blockerId: ME, blockedId: THEM },
      { blockerId: THEM, blockedId: ME },
    ]) {
      const error = await assertNotBlocked(readerWith([row]), ME, THEM).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: "FORBIDDEN",
        message: BLOCKED_PAIR_MESSAGE,
      });
    }
  });

  it("says nothing about who blocked whom", () => {
    // The blocked party sees this too, so it must not name the act.
    expect(BLOCKED_PAIR_MESSAGE.toLowerCase()).not.toMatch(/block/);
  });

  it("accepts one id or a list, and resolves when there is no block", async () => {
    const prisma = readerWith([{ blockerId: OTHER, blockedId: THEM }]);

    await expect(assertNotBlocked(prisma, ME, THEM)).resolves.toBeUndefined();
    await expect(
      assertNotBlocked(prisma, ME, [THEM, OTHER]),
    ).resolves.toBeUndefined();
    await expect(assertNotBlocked(prisma, THEM, [ME, OTHER])).rejects.toThrow(
      BLOCKED_PAIR_MESSAGE,
    );
  });
});
