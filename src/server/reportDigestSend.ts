import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import type { SESClient } from "@aws-sdk/client-ses";
import { resolveAdminRecipients } from "./adminReportAlert";
import { generateAdminReportDigestEmailParams } from "./emailParams";
import {
  formatReasonBreakdown,
  summariseReports,
  type DigestReportRow,
  type ReportDigestSummary,
} from "./reportDigest";
import {
  formatReportingWindow,
  previousCompletedWeek,
  type ReportingWindow,
} from "./reportDigestWindow";
import {
  claimDigestWindow,
  markDigestSent,
  releaseDigestClaim,
  type ReportDigestStore,
} from "./db/reportDigestDelivery";

/**
 * Sending the weekly admin report digest.
 *
 * The five pieces this assembles each live somewhere they can be tested on
 * their own, and this file is only the order they go in:
 *
 *   `reportDigestWindow.ts`      which week, derived from the calendar
 *   `reportDigestDelivery.ts`    whether that week has already been sent
 *   `reportDigest.ts`            the counts, from two columns of `Report`
 *   `adminReportAlert.ts`        who staff are, resolved from `Permission`
 *   `emailParams.ts`             the `TemplateData`
 *
 * ## Why most reports no longer mail anybody on filing
 *
 * SCRUM-621 mailed every admin the moment any report was filed. That is right
 * for a report that cannot wait and wrong for the other five reasons: 20
 * reports per reporter per day are allowed, each one mailed the whole roster,
 * and mail that is mostly not urgent stops being read — which costs the
 * alerts that are. `reports.create` now consults
 * `isCriticalReportReason`, and everything else arrives here.
 *
 * **A critical report is in both.** It mails immediately *and* is counted in
 * the week's digest, because the digest is the complete picture of a week
 * rather than the leftovers, and an admin reconciling the two should not find
 * the urgent ones missing from the summary.
 *
 * ## Why a digest is sent even when nothing was reported
 *
 * An empty week still sends, and that is a decision rather than an oversight.
 * A silent week is indistinguishable from a digest that is broken — an expired
 * credential, an unpublished template, a trigger that stopped firing — and
 * this is the mechanism telling staff that a safety queue needs attention, so
 * failing silently is the one failure mode it must not have. One mail a week
 * saying "no reports" is a cheap heartbeat.
 *
 * `REPORT_DIGEST_SEND_WHEN_EMPTY` is the one place to change that.
 *
 * ## The email budget
 *
 * This claims none, for exactly the reasons `adminReportAlert.ts` argues at
 * length about the immediate alert: `claimEmailBudget` is keyed to the sender,
 * there is no sender here at all, and the recipients are staff resolved from
 * `Permission` rather than an address anybody can choose — so the abuse the
 * budget exists to prevent is structurally impossible on this path. A reserved
 * key of its own would be worse than nothing: a global cap on digests is
 * spendable by whatever else claimed it, which would silence a week's digest
 * to protect a quota nobody is competing for. One mail a week to staff needs
 * no cap.
 */

/** Whether a week with no reports still sends a digest. See the note above. */
export const REPORT_DIGEST_SEND_WHEN_EMPTY = true;

/**
 * The Prisma surface the digest needs: the delivery table, the report rows,
 * and the admin roster.
 */
export type ReportDigestPrisma = ReportDigestStore &
  Pick<PrismaClient, "report" | "user">;

export type DigestPreview = {
  window: ReportingWindow;
  windowLabel: string;
  summary: ReportDigestSummary;
  recipientCount: number;
};

export type DigestRunOutcome =
  | ({ status: "sent"; attempt: number } & DigestPreview)
  | {
      status: "skipped";
      window: ReportingWindow;
      /**
       * `already_sent` — delivered previously; the retry guard working.
       * `held_by_another_run` — a concurrent run owns it.
       * `no_recipients` — nobody is staff, or staging may mail none of them.
       * `empty_week` — no reports, and sending when empty is switched off.
       */
      reason:
        "already_sent" | "held_by_another_run" | "no_recipients" | "empty_week";
    }
  | {
      status: "failed";
      window: ReportingWindow;
      /**
       * `send_failed` — SES rejected it. The window stays claimable, so the
       * next run retries the same week.
       * `state_not_recorded` — the mail was accepted but this run no longer
       * held the claim, so the delivery could not be written down. See
       * `markDigestSent`; this is the one outcome that needs a human.
       */
      reason: "send_failed" | "state_not_recorded";
    };

/**
 * The two columns of `Report` a digest may read.
 *
 * `select` is explicit and narrow on purpose. `Report` also holds the
 * reporter's `message` and the `conversationSnapshot` copied off a
 * conversation, and the privacy guarantee is easiest to keep when the content
 * is never fetched in the first place — a value that was never read cannot be
 * interpolated into an email by a later edit. `reportDigest.ts` states the
 * same boundary at the type level.
 *
 * Half-open on `dateCreated`: `gte` the Monday, `lt` the next Monday. A report
 * filed at the exact boundary instant belongs to the week that is opening,
 * counted once, and the `[status, dateCreated]` index serves the range.
 */
export const collectDigestRows = async (
  prisma: Pick<PrismaClient, "report">,
  window: ReportingWindow,
): Promise<DigestReportRow[]> =>
  prisma.report.findMany({
    where: { dateCreated: { gte: window.start, lt: window.end } },
    select: { reportedUserId: true, reason: true },
  });

/**
 * What a digest for this instant's week would say, touching no state.
 *
 * Used by `scripts/send-report-digest.ts` for its dry run, so that an operator
 * can see the week, the counts and the recipient count without claiming the
 * window or sending anything. Nothing here writes, which is what makes the
 * script safe to point at production without `--apply`.
 */
export const previewReportDigest = async (
  prisma: ReportDigestPrisma,
  now: Date = new Date(),
  window: ReportingWindow = previousCompletedWeek(now),
): Promise<DigestPreview> => {
  const [rows, recipientEmails] = await Promise.all([
    collectDigestRows(prisma, window),
    resolveAdminRecipients(prisma),
  ]);

  return {
    window,
    windowLabel: formatReportingWindow(window),
    summary: summariseReports(rows),
    recipientCount: recipientEmails.length,
  };
};

/**
 * Claims the window, sends the digest, and records the delivery.
 *
 * Resolves rather than rejecting on every outcome, like `notifyAdminsOfReport`
 * — a caller should not have to catch anything to find out what happened, and
 * the script turns the outcome into an exit code.
 *
 * The order is the whole design. The claim comes **before** the read, so two
 * concurrent runs cannot both do the work; the send comes before the `SENT`
 * write, so a failed send cannot leave a window marked delivered; and the
 * claim is released on the failure path, so the next run retries the same week
 * rather than waiting out the lease.
 */
export const sendReportDigest = async (
  prisma: ReportDigestPrisma,
  ses: Pick<SESClient, "send">,
  now: Date = new Date(),
  options: { window?: ReportingWindow; token?: string } = {},
): Promise<DigestRunOutcome> => {
  const window = options.window ?? previousCompletedWeek(now);
  // Supplied by tests; a fresh uuid per run otherwise, which is all the token
  // has to be — it identifies one attempt, and nothing reads it as data.
  const token = options.token ?? randomUUID();

  const claim = await claimDigestWindow(prisma, window, token, now);
  if (!claim.claimed) {
    return { status: "skipped", window, reason: claim.reason };
  }

  try {
    const [rows, recipientEmails] = await Promise.all([
      collectDigestRows(prisma, window),
      resolveAdminRecipients(prisma),
    ]);

    const summary = summariseReports(rows);
    const windowLabel = formatReportingWindow(window);

    if (recipientEmails.length === 0) {
      // Not a fault. A deployment with no admins yet, or a staging roster
      // with no gmail address, is a real state — `isDeliverableRecipient`
      // filters rather than throwing for exactly this reason. The claim goes
      // back so that a roster fixed later still gets this week's digest.
      await releaseDigestClaim(prisma, window, token);
      return { status: "skipped", window, reason: "no_recipients" };
    }

    if (summary.reportCount === 0 && !REPORT_DIGEST_SEND_WHEN_EMPTY) {
      await releaseDigestClaim(prisma, window, token);
      return { status: "skipped", window, reason: "empty_week" };
    }

    // Imported here rather than at module scope. The type-only import above
    // is erased, and `@aws-sdk/client-ses` throws `ReferenceError:
    // TextDecoder is not defined` from its CBOR submodule under jsdom — so a
    // module-scope import makes component suites fail to *load* several files
    // away from anything to do with email. `adminReportAlert.ts` defers it
    // for the same reason.
    const { SendTemplatedEmailCommand } = await import("@aws-sdk/client-ses");

    await ses.send(
      new SendTemplatedEmailCommand(
        generateAdminReportDigestEmailParams({
          recipientEmails,
          windowLabel,
          reasonBreakdown: formatReasonBreakdown(summary),
          reportCount: summary.reportCount,
          uniqueReportedUserCount: summary.uniqueReportedUserCount,
          repeatedReportedUserCount: summary.repeatedReportedUserCount,
          highestReportsAboutOneUser: summary.highestReportsAboutOneUser,
          criticalReportCount: summary.criticalReportCount,
        }),
      ),
    );

    const recorded = await markDigestSent(
      prisma,
      window,
      token,
      {
        reportCount: summary.reportCount,
        recipientCount: recipientEmails.length,
      },
      now,
    );

    if (!recorded) {
      // The mail was accepted and the row does not say so, which can only
      // happen if this run's lease expired and another run took the window
      // over mid-flight. Deliberately **not** retried and not forced: writing
      // `SENT` from here would overwrite whatever the new owner is doing.
      // Logged at error level because the next run may now send a second copy
      // of this week, and a human should know which week that was.
      console.error(
        "Report digest was sent but could not be recorded as delivered; " +
          "the claim was lost mid-flight and this week may be sent again.",
        { windowStart: window.start.toISOString() },
      );
      return { status: "failed", window, reason: "state_not_recorded" };
    }

    return {
      status: "sent",
      attempt: claim.attempt,
      window,
      windowLabel,
      summary,
      recipientCount: recipientEmails.length,
    };
  } catch (error) {
    // Wide on purpose: the report read, the roster read and the send can each
    // fail, and in every case the right thing is the same — give the claim
    // back so the window is retried, and do not mark it delivered.
    //
    // `AdminReportDigestTemplate` lives in AWS, not in this repository. Until
    // someone runs `python3 scripts/emailtemplate.py --apply`, SES answers
    // every send here with `TemplateDoesNotExist` and this is the line that
    // will say so.
    console.error("Could not send the weekly admin report digest", error);

    // Releasing can itself fail, and a failure here must not mask the one
    // above. An unreleased claim expires on its own after
    // `DIGEST_CLAIM_LEASE_MS`, so the window is still retried, just later.
    try {
      await releaseDigestClaim(prisma, window, token);
    } catch (releaseError) {
      console.error(
        "Could not release the report digest claim after a failed send",
        releaseError,
      );
    }

    return { status: "failed", window, reason: "send_failed" };
  }
};
