import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";
import type { PrismaOrTransaction } from "../../db/client";

/**
 * Blocking another user.
 *
 * What a block *does* is enforced where two users meet, through
 * `src/server/db/blocks.ts`. This router only creates, lists and removes the
 * row. The acting user always comes from the session: `userId` in the inputs
 * below names who is being blocked, never who is blocking.
 */

/**
 * What a block of someone you carpool with is refused with.
 *
 * A group is a live arrangement to share a car, and a block hides the pair
 * from each other everywhere. Doing both at once would leave two people who
 * are still riding together unable to message, and one of them unable to see
 * why. Leaving comes first. That is a product decision, not a technical
 * limitation.
 *
 * **The message states the reason, not just the rule.** The rule asks the
 * user to take the irreversible, socially costly step - leaving a carpool -
 * before the protective one, so the refusal needs to account for that order.
 * Two ways out were weighed:
 *
 *  1. *Explain, don't automate.* Keep the rule and say why, which is this.
 *  2. *A combined "leave and block".* One control that leaves, then blocks.
 *
 * The second was rejected, and not on cost. It compounds two actions of which
 * one is irreversible in practice, and its failure mode is the dangerous one:
 * a leave that succeeds followed by a block that fails leaves somebody out of
 * their carpool *and* believing they are protected when they are not. The
 * refusal itself is cheap to act on - Leave is one control away on the same
 * screen - so the combined path buys a small amount of convenience with a
 * state nobody can see they are in. If it is ever built, the server sequence
 * and its partial failure need their own real-database test first.
 *
 * The order of the sentences is deliberate: the remedy, then the rule, then
 * the reason. This is read in a toast by someone who has just been told no,
 * and the first thing they need is what to do instead.
 *
 * Note that this is the *only* outcome a Block from the group page can have -
 * every row on that screen is by definition a groupmate - so this copy is not
 * an error path there, it is the feature. See `GroupMemberCard`.
 */
export const BLOCK_GROUP_MEMBER_MESSAGE =
  "Leave the group first. You can't block someone you're carpooling with: a " +
  "block hides you both from each other everywhere, which would strand two " +
  "people who are still sharing a car.";

const requireCallerId = (userId: string | undefined): string => {
  if (!userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User not authenticated.",
    });
  }
  return userId;
};

/**
 * Records `blockerId`'s block of `blockedId`, or throws the refusal.
 *
 * Shared by `user.blocks.block` and by `user.reports.create`'s "Also block",
 * so a report cannot place a block the Block button would have
 * refused. Takes the client as a parameter because the report path runs it
 * inside the transaction that writes the report, and `user.blocks.block`
 * below now opens one of its own for the same reason. Every refusal is
 * thrown before the upsert, so a caller inside a transaction can catch one
 * and carry on.
 *
 * **This closes a race between a block and a concurrent group join.** A
 * plain, non-locking read of group membership here, paired with
 * `groups.create`/`groups.edit`'s own `assertNotBlocked` call as the only
 * check on their side - both plain reads inside their own transaction - would
 * let a block landing at the same moment as a request being accepted have
 * each side check against the other's pre-race state and both commit, leaving
 * a blocked pair sharing a group. Avoided the same way the sibling
 * `carpool_search` races are avoided: a plain `SELECT` under REPEATABLE READ
 * answers from this transaction's starting snapshot, not the current row, so
 * the read below is a raw `SELECT ... FOR UPDATE` over both users'
 * `carpool_search` rows - the same rows `groups.create`/`groups.edit`'s raw
 * `UPDATE` claims - which serializes this transaction against theirs instead
 * of racing it. That alone only protects *this* side: `groups.create`/
 * `groups.edit` re-check with their own locking read,
 * `assertNotBlockedForUpdate` in `../../db/blocks.ts`, immediately after their
 * `carpoolId` claim succeeds, so a block that commits in the gap is still
 * caught there. Verified against a real MySQL in
 * `blockGroupJoinRace.db.test.ts`, using the same barrier-proxy technique as
 * `groupRoleRace.db.test.ts`.
 */
export const applyBlock = async (
  prisma: PrismaOrTransaction,
  blockerId: string,
  blockedId: string,
): Promise<void> => {
  if (blockedId === blockerId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "You can't block yourself.",
    });
  }

  // `relationMode = "prisma"` emulates the relation, which covers cascades
  // but does not check that `blockedId` exists on insert. Without this, any
  // string would be stored as a block.
  const target = await prisma.user.findUnique({
    where: { id: blockedId },
    select: { id: true },
  });

  if (!target) {
    throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
  }

  // A locking current read, not `carpoolSearch.findMany`: see the long
  // comment above. `groups.create`/`groups.edit` claim a rider's row
  // here with a raw `UPDATE`, so locking it first makes a concurrent accept
  // wait behind this transaction rather than pass its own check against this
  // pair's pre-block state. Raw SQL bypasses Prisma's field mapping, but
  // `userId` and `carpoolId` on this table have none.
  const searches = await prisma.$queryRaw<
    { userId: string; carpoolId: string | null }[]
  >`
    SELECT userId, carpoolId FROM carpool_search
    WHERE userId IN (${blockerId}, ${blockedId})
    FOR UPDATE
  `;
  const callerGroup = searches.find((s) => s.userId === blockerId)?.carpoolId;
  const targetGroup = searches.find((s) => s.userId === blockedId)?.carpoolId;

  // The same shape as `requests.create`'s guard: `callerGroup &&` covers
  // null and undefined together, so two ungrouped users never match.
  if (callerGroup && callerGroup === targetGroup) {
    throw new TRPCError({
      code: "CONFLICT",
      message: BLOCK_GROUP_MEMBER_MESSAGE,
    });
  }

  // An upsert on the unique pair is what makes this idempotent. The empty
  // `update` leaves an existing row, and its `dateCreated`, as they were.
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });
};

const targetInput = z.object({ userId: z.string().min(1) }).strict();

export const blocksRouter = router({
  /**
   * The users the caller has blocked, newest first.
   *
   * Only rows where the caller is the blocker. Blocks *against* the caller are
   * enforced everywhere but never listed, because listing them would tell a
   * blocked user who blocked them.
   *
   * The display name is resolved here rather than by sending back a
   * `PublicUser`. The list needs a name to put beside Unblock, and nothing
   * more about someone the caller has chosen to stop seeing.
   */
  me: protectedRouter.query(async ({ ctx }) => {
    const userId = requireCallerId(ctx.session.user?.id);

    const rows = await ctx.prisma.block.findMany({
      where: { blockerId: userId },
      orderBy: { dateCreated: "desc" },
      select: {
        blockedId: true,
        dateCreated: true,
        blocked: { select: { preferredName: true, name: true } },
      },
    });

    return rows.map((row) => ({
      userId: row.blockedId,
      name: row.blocked.preferredName || row.blocked.name || "Unknown user",
      blockedAt: row.dateCreated,
    }));
  }),

  /**
   * Blocks `userId`. Idempotent: blocking someone already blocked succeeds and
   * changes nothing, so a double-click or a stale second menu cannot fail.
   *
   * Nothing between the pair is deleted. See `blocks.ts` for why hiding is
   * the rule.
   *
   * Runs inside an explicit transaction: `applyBlock` takes a `FOR UPDATE`
   * lock on `carpool_search` rows, which only serializes against a
   * concurrent group-join if it is held until the block itself commits,
   * rather than released at the end of one autocommitted statement.
   */
  block: protectedRouter.input(targetInput).mutation(async ({ ctx, input }) => {
    const userId = requireCallerId(ctx.session.user?.id);

    await ctx.prisma.$transaction((tx) => applyBlock(tx, userId, input.userId));

    return { blocked: true as const };
  }),

  /**
   * Removes the caller's block of `userId`. Idempotent, and scoped to the
   * caller's own row: it cannot lift a block someone else placed on them.
   * What was hidden reappears, because nothing was deleted.
   */
  unblock: protectedRouter
    .input(targetInput)
    .mutation(async ({ ctx, input }) => {
      const userId = requireCallerId(ctx.session.user?.id);

      await ctx.prisma.block.deleteMany({
        where: { blockerId: userId, blockedId: input.userId },
      });

      return { blocked: false as const };
    }),
});
