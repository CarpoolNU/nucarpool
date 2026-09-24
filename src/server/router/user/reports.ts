import { ReportReason, ReportStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import { REPORT_SNAPSHOT_MESSAGE_LIMIT } from "../../../utils/reports";
import { buildConversationSnapshot } from "../../reportSnapshot";
import { applyBlock } from "./blocks";

/**
 * Reporting another user (SCRUM-555, phase 3 of SCRUM-532).
 *
 * The reporter always comes from the session. `reportedUserId` names who the
 * report is about, never who is making it.
 *
 * Nothing here tells the reported user anything. A report is read by admins
 * only, through `user.admin.getReports`.
 */

/** What a second OPEN report about the same person is refused with. */
export const DUPLICATE_REPORT_MESSAGE =
  "You already have an open report about this user. An admin will review it.";

/** What a report naming someone else's conversation is refused with. */
export const REPORT_REQUEST_MISMATCH_MESSAGE =
  "That conversation isn't with this user.";

const createInput = z
  .object({
    reportedUserId: z.string().min(1),
    reason: z.nativeEnum(ReportReason),
    // Trimmed before the cap, as `sendMessage` does, so whitespace cannot use
    // up the limit. Empty after trimming is stored as null.
    message: z.string().trim().max(REPORT_MESSAGE_MAX_LENGTH).optional(),
    // The conversation the report was made from, when it was made from one.
    requestId: z.string().min(1).optional(),
    alsoBlock: z.boolean(),
  })
  .strict();

export const reportsRouter = router({
  /**
   * Files a report, and optionally blocks the same person.
   *
   * With a `requestId`, the report keeps the last
   * `REPORT_SNAPSHOT_MESSAGE_LIMIT` messages of that conversation, copied
   * here on the server. The caller must be a party to that request, and the
   * reported user must be the other party, or a user could attach anyone's
   * thread to a report.
   *
   * **A refused block never costs the report.** Blocking someone in your own
   * group is refused (`BLOCK_GROUP_MEMBER_MESSAGE`), but the report still
   * saves and the refusal comes back as `blockRefusal` for the client to show.
   * A failure of any other kind rolls back both, so a retry does not meet a
   * duplicate.
   */
  create: protectedRouter
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      const reporterId = ctx.session.user?.id;
      if (!reporterId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated.",
        });
      }

      if (input.reportedUserId === reporterId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You can't report yourself.",
        });
      }

      // `relationMode = "prisma"` does not check that `reportedUserId` exists on
      // insert, the same gap `applyBlock` closes for blocks.
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.reportedUserId },
        select: { id: true },
      });
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found." });
      }

      if (input.requestId) {
        const request = await ctx.prisma.request.findUnique({
          where: { id: input.requestId },
          select: { fromUserId: true, toUserId: true },
        });

        if (!request) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This conversation no longer exists.",
          });
        }

        // Checked before any message is read, as `messages.conversation` does,
        // so a refused caller gets no content at all.
        if (
          request.fromUserId !== reporterId &&
          request.toUserId !== reporterId
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a participant in this conversation.",
          });
        }

        const counterpartId =
          request.fromUserId === reporterId
            ? request.toUserId
            : request.fromUserId;
        if (counterpartId !== input.reportedUserId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: REPORT_REQUEST_MISMATCH_MESSAGE,
          });
        }
      }

      // One OPEN report per reporter and person. A report that has been
      // reviewed or dismissed (SCRUM-552) does not stop a new one, because
      // something new may have happened. There is no constraint behind this,
      // since the rule depends on `status`, so two simultaneous submissions can
      // both pass. The dialog disables Submit while one is in flight.
      const existing = await ctx.prisma.report.findFirst({
        where: {
          reporterId,
          reportedUserId: input.reportedUserId,
          status: ReportStatus.OPEN,
        },
        select: { id: true },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: DUPLICATE_REPORT_MESSAGE,
        });
      }

      const requestId = input.requestId;
      const conversationSnapshot = requestId
        ? buildConversationSnapshot(
            // The same thread `messages.conversation` shows, read the same way:
            // newest first to cap at the most recent, with `id` breaking ties.
            await ctx.prisma.message.findMany({
              where: { conversation: { requestId } },
              orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
              take: REPORT_SNAPSHOT_MESSAGE_LIMIT,
              select: { userId: true, content: true, dateCreated: true },
            }),
          )
        : null;

      return ctx.prisma.$transaction(async (tx) => {
        const report = await tx.report.create({
          data: {
            reporterId,
            reportedUserId: input.reportedUserId,
            reason: input.reason,
            message: input.message || null,
            requestId: requestId ?? null,
            conversationSnapshot,
          },
          select: { id: true },
        });

        let blocked = false;
        let blockRefusal: string | null = null;

        if (input.alsoBlock) {
          try {
            await applyBlock(tx, reporterId, input.reportedUserId);
            blocked = true;
          } catch (error) {
            // Only the group refusal is expected. `applyBlock` throws it before
            // writing anything, so the transaction is still sound to commit.
            if (error instanceof TRPCError && error.code === "CONFLICT") {
              blockRefusal = error.message;
            } else {
              throw error;
            }
          }
        }

        return { reportId: report.id, blocked, blockRefusal };
      });
    }),
});
