import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";
import type { PrismaOrTransaction } from "../../db/client";

/**
 * Blocking another user (SCRUM-554).
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
 */
export const BLOCK_GROUP_MEMBER_MESSAGE =
  "Leave the group first. You can't block someone you're carpooling with.";

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
 * Shared by `user.blocks.block` and by `user.reports.create`'s "Also block"
 * (SCRUM-555), so a report cannot place a block the Block button would have
 * refused. Takes the client as a parameter because the report path runs it
 * inside the transaction that writes the report. Every refusal is thrown before
 * the upsert, so a caller inside a transaction can catch one and carry on.
 *
 * **Known, accepted race (SCRUM-562, not fixed here).** The group-membership
 * read a few lines down and `groups.create`/`groups.edit`'s own
 * `assertNotBlocked` calls are both plain, non-locking reads inside their own
 * transaction. A block landing at the same moment as a request being accepted
 * can have each side check against the other's pre-race state and have both
 * commit, leaving a blocked pair sharing a group. SCRUM-562's audit called
 * this "plausible; needs simultaneous timing" - it has never been observed,
 * and closing it for real needs the same real-MySQL-verified locking reads
 * SCRUM-563/565 used for the *other* races here (a plain `SELECT` under
 * REPEATABLE READ answers from this transaction's starting snapshot, not the
 * current row, so the fix is a raw `FOR UPDATE` read timed against the
 * carpoolId claim in `groups.ts` - not something to land unverified). Even
 * landed, the pair still cannot message each other and either can leave, so
 * the accepted exposure is a blocked pair briefly sharing a group roster,
 * not a channel between them. Tracked for the real fix rather than fixed
 * here: see the ticket filed alongside SCRUM-562.
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

  const searches = await prisma.carpoolSearch.findMany({
    where: { userId: { in: [blockerId, blockedId] } },
    select: { userId: true, carpoolId: true },
  });
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
   */
  block: protectedRouter.input(targetInput).mutation(async ({ ctx, input }) => {
    const userId = requireCallerId(ctx.session.user?.id);

    await applyBlock(ctx.prisma, userId, input.userId);

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
