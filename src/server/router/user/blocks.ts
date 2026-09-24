import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";

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

    if (input.userId === userId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You can't block yourself.",
      });
    }

    // `relationMode = "prisma"` emulates the relation, which covers cascades
    // but does not check that `blockedId` exists on insert. Without this, any
    // string would be stored as a block.
    const target = await ctx.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });

    if (!target) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
    }

    const searches = await ctx.prisma.carpoolSearch.findMany({
      where: { userId: { in: [userId, input.userId] } },
      select: { userId: true, carpoolId: true },
    });
    const callerGroup = searches.find((s) => s.userId === userId)?.carpoolId;
    const targetGroup = searches.find(
      (s) => s.userId === input.userId,
    )?.carpoolId;

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
    await ctx.prisma.block.upsert({
      where: {
        blockerId_blockedId: { blockerId: userId, blockedId: input.userId },
      },
      create: { blockerId: userId, blockedId: input.userId },
      update: {},
    });

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
