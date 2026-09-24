import { TRPCError } from "@trpc/server";
import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Block checks, shared by every server path where two users meet (SCRUM-554).
 *
 * **A block is one row but a symmetric effect.** `Block` records who blocked
 * whom, and only the blocker can remove it. What it *does* holds in both
 * directions: neither user sees the other in discovery, and neither can
 * request, message, join a group with or notify the other. So every helper
 * here matches a row in either direction. A helper that checked only
 * `blockerId = me` would let the blocked user go on reaching the blocker,
 * which is the case blocking exists for.
 *
 * **Hide, don't delete.** Requests, favourites and conversations between a
 * blocked pair are filtered out where they are read, not destroyed, so
 * unblocking restores them exactly and nothing a later report might need is
 * lost. The exits stay open deliberately. `requests.delete` and the group
 * leave and remove paths do not consult a block, because a user must always
 * be able to get out.
 */

/**
 * The Prisma surface these helpers touch. It is narrow on purpose, so the
 * router tests' in-memory fakes only have to supply `block.findFirst` and
 * `block.findMany`. Both the base client and a transaction client satisfy it.
 */
export type BlockReader = {
  block: Pick<PrismaClient["block"], "findFirst" | "findMany">;
};

/**
 * What either party is told when a block stops an action.
 *
 * Deliberately generic, and the same for both directions: the blocked user
 * must not be able to learn from an error that they were blocked, and a
 * blocker who hits it already knows why. Nothing in the response says who
 * blocked whom.
 */
export const BLOCKED_PAIR_MESSAGE = "This user isn't available.";

/**
 * Block rows in either direction between `userId` and any of `counterpartIds`.
 *
 * `blockedId` is indexed for the reverse lookup, and the unique pair leads
 * with `blockerId`, so both halves of the `OR` are index reads.
 */
const eitherDirection = (
  userId: string,
  counterpartIds: readonly string[],
): Prisma.BlockWhereInput => ({
  OR: [
    { blockerId: userId, blockedId: { in: [...counterpartIds] } },
    { blockedId: userId, blockerId: { in: [...counterpartIds] } },
  ],
});

/**
 * Every user `userId` has a block with, in either direction.
 *
 * This is the exclusion list for surfaces that return many users:
 * recommendations, the map, favourites, requests and the unread count. The
 * result can include ids the caller never blocked, namely people who blocked
 * *them*. That is correct here, and it is why this list must never be sent to
 * the client as it is. `user.blocks.me` reads only the caller's own
 * `blockerId` rows for that reason.
 */
export const blockedCounterpartIds = async (
  prisma: BlockReader,
  userId: string,
): Promise<string[]> => {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });

  return [
    ...new Set(
      rows.map((row) =>
        row.blockerId === userId ? row.blockedId : row.blockerId,
      ),
    ),
  ];
};

/**
 * True when there is a block in either direction between `userId` and any of
 * `counterpartIds`.
 *
 * Taking a list is what lets `groups.edit` check a joining rider against a
 * whole group in one query. An empty list is never blocked and reads nothing.
 */
export const isBlockedWithAny = async (
  prisma: BlockReader,
  userId: string,
  counterpartIds: readonly string[],
): Promise<boolean> => {
  if (counterpartIds.length === 0) {
    return false;
  }

  const row = await prisma.block.findFirst({
    where: eitherDirection(userId, counterpartIds),
    select: { id: true },
  });

  return row !== null;
};

/** True when either of these two users has blocked the other. */
export const isBlockedPair = (
  prisma: BlockReader,
  userId: string,
  otherUserId: string,
): Promise<boolean> => isBlockedWithAny(prisma, userId, [otherUserId]);

/**
 * Throws FORBIDDEN, with `BLOCKED_PAIR_MESSAGE`, when `userId` has a block in
 * either direction with `counterpartIds`, which may be one id or several.
 *
 * FORBIDDEN is in `NON_RETRYABLE_CODES`, so the client shows the refusal once
 * rather than retrying into it three times.
 */
export const assertNotBlocked = async (
  prisma: BlockReader,
  userId: string,
  counterpartIds: string | readonly string[],
): Promise<void> => {
  const ids =
    typeof counterpartIds === "string" ? [counterpartIds] : counterpartIds;

  if (await isBlockedWithAny(prisma, userId, ids)) {
    throw new TRPCError({ code: "FORBIDDEN", message: BLOCKED_PAIR_MESSAGE });
  }
};
