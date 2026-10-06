import { ReportReason, ReportStatus } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "../createRouter";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import {
  isCriticalReportReason,
  REPORT_SNAPSHOT_MESSAGE_LIMIT,
} from "../../../utils/reports";
import { buildConversationSnapshot } from "../../reportSnapshot";
import { notifyAdminsOfReport } from "../../adminReportAlert";
import { applyBlock } from "./blocks";

/**
 * Reporting another user.
 *
 * The reporter always comes from the session. `reportedUserId` names who the
 * report is about, never who is making it.
 *
 * Nothing here tells the reported user anything. A report is read by admins
 * only, through `user.admin.getReports`.
 *
 * Filing one reaches the admins by mail — the fact of a report and its
 * reason, never a word of it — so the queue is no longer pull-only. **Which
 * mail depends on the reason.** A critical one (`REPORT_URGENCY` in
 * `utils/reports.ts`, currently `SAFETY_CONCERN` alone) sends an immediate
 * alert from here; every other reason is counted in the weekly digest
 * instead, and a critical report appears in that too. See
 * `adminReportAlert.ts` for the immediate path, including why its send claims
 * no email budget and why it can never fail the report, and
 * `reportDigestSend.ts` for the weekly one.
 */

/**
 * What a second OPEN report about the same person is refused with.
 *
 * It names where the first one can be read. Before `me` existed the refusal
 * pointed at a row the reporter had no way to look at, so somebody who had
 * forgotten whether they had already reported this person - or who now had
 * more to say - was told only that they could not proceed. The wording tracks
 * the heading in `ReportsFiledSection`; the two have to stay in step, which is
 * what `reports.test.ts` asserts.
 */
export const DUPLICATE_REPORT_MESSAGE =
  "You already have an open report about this user. You can see it, and any " +
  'decision an admin makes, under "Reports You\'ve Filed" in your profile.';

/**
 * How many reports one reporter may file inside `REPORT_RATE_LIMIT_WINDOW_MS`.
 * Every user id is visible in every map and recommendation
 * payload, so nothing before this stopped a script from filing an OPEN
 * report - each carrying up to the full reason text - against every user it
 * can see, with no prior interaction. `getReports` reads back only the
 * newest `REPORT_QUEUE_PAGE_SIZE` rows, so a flood like that pushes real
 * reports out of what admins can see. Matches the shape of
 * `REQUEST_NOTIFICATIONS_PER_WINDOW` in `email.ts`: a plain `count` over a
 * rolling window, not a token bucket, because reports are rare enough that
 * the difference does not matter.
 */
const REPORT_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPORTS_PER_WINDOW = 20;

/** What filing past the per-reporter rate limit is refused with. */
export const REPORT_RATE_LIMIT_MESSAGE =
  "You've filed a lot of reports recently. Try again later.";

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
   * The reports the caller has filed, newest first.
   *
   * Only rows where the caller is the *reporter*. Reports filed **against**
   * the caller are never listed and must not be: the product deliberately
   * tells a reported user nothing, and a list keyed on `reportedUserId` would
   * undo that in one query.
   *
   * The reported person's display name is resolved here rather than by
   * sending back a `PublicUser`, exactly as `blocks.me` does and for the same
   * reason: the row needs a name to be legible, and the reporter already had
   * that name when they filed. Nothing else about that user crosses the wire.
   *
   * `conversationSnapshot` is deliberately **not** selected. It is the other
   * party's words as well as the reporter's, kept for admins to review; the
   * reporter saw the thread when they filed it, and replaying it here would
   * hand back a copy that outlives a deleted conversation.
   *
   * `dateModified` is `@updatedAt`, and `admin.resolveReport` is the only
   * thing that writes a report after it is created - so for a row that has
   * left `OPEN` it is when that decision was made. A future procedure that
   * edits a report for any other reason would make that read wrong, which is
   * why the client shows it only for a resolved report.
   */
  me: protectedRouter.query(async ({ ctx }) => {
    const reporterId = ctx.session.user?.id;
    if (!reporterId) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "User not authenticated.",
      });
    }

    const rows = await ctx.prisma.report.findMany({
      where: { reporterId },
      // `id` breaks ties, as the snapshot read below does: two reports filed
      // in the same second would otherwise come back in an arbitrary order,
      // and a list that reorders itself between loads reads as a bug.
      orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
      select: {
        id: true,
        reason: true,
        message: true,
        status: true,
        dateCreated: true,
        dateModified: true,
        reportedUser: { select: { preferredName: true, name: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      reportedName:
        row.reportedUser.preferredName ||
        row.reportedUser.name ||
        "Unknown user",
      reason: row.reason,
      message: row.message,
      status: row.status,
      filedAt: row.dateCreated,
      updatedAt: row.dateModified,
    }));
  }),

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

      // Cheap and early, before the requestId/snapshot work below: a script
      // filing reports against every user it can see should not get to pay
      // for a message read on every one of them.
      const recentReportCount = await ctx.prisma.report.count({
        where: {
          reporterId,
          dateCreated: {
            gte: new Date(Date.now() - REPORT_RATE_LIMIT_WINDOW_MS),
          },
        },
      });
      if (recentReportCount >= REPORTS_PER_WINDOW) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: REPORT_RATE_LIMIT_MESSAGE,
        });
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
      // reviewed or dismissed by `admin.resolveReport` does not stop a new
      // one, because something new may have happened. There is no
      // constraint behind this,
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

      const result = await ctx.prisma.$transaction(async (tx) => {
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

      // **Outside the transaction, and after it has committed.** Inside it an
      // SES failure would roll the report back — exactly backwards, since the
      // report is the thing that matters and the alert is best-effort.
      //
      // Awaited for completion but not for its value. `notifyAdminsOfReport`
      // resolves on every failure path and logs its own, so there is no
      // rejection to catch here and nothing a reporter sees changes because
      // an admin mailbox was briefly unreachable. It is still awaited rather
      // than left dangling, because this runs in a Next.js API route: a
      // promise in flight when the handler returns can be cut off when the
      // process is frozen between invocations, so a fire-and-forget send
      // would be dropped silently on exactly the deployment it has to work
      // on. The cost is that filing a report waits for one SES call.
      //
      // It is passed the reason and nothing else about the report — no id, no
      // message, no snapshot. See `AdminReportEmailSchema`.
      //
      // **Only the critical reasons mail anybody here.** Every reason used to,
      // which made a `NO_SHOW` report arrive at the same urgency as somebody
      // saying they felt unsafe in a car — and since `REPORTS_PER_WINDOW`
      // admits 20 reports per reporter per day, each mailing the whole
      // roster, the mail was mostly not urgent and therefore at risk of not
      // being read at all. The rest are counted in the weekly digest
      // (`reportDigestSend.ts`), which a critical report also appears in, so
      // nothing is dropped and nothing is reported twice over.
      //
      // `isCriticalReportReason` is the only thing consulted, and
      // `REPORT_URGENCY` beside it is the only place that decides. Moving a
      // reason between the two behaviours is a one-line change there.
      if (isCriticalReportReason(input.reason)) {
        await notifyAdminsOfReport(ctx.prisma, ctx.sesClient, input.reason);
      }

      return result;
    }),
});
