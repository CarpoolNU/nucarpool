import type { ReportReason } from "@prisma/client";
import {
  isCriticalReportReason,
  REPORT_REASONS,
  REPORT_REASON_LABELS,
} from "../utils/reports";

/**
 * Turning a week of reports into the handful of numbers the digest carries.
 *
 * Pure, Prisma-free and React-free, like `adminDataUtils.ts` and for the same
 * reason: the aggregation is the part with the interesting edge cases, and it
 * stays unit-testable only while nothing in here needs a database. The read
 * that supplies `rows` lives in `reportDigestSend.ts`.
 *
 * ## What a row is allowed to be
 *
 * `DigestReportRow` is two fields, and that is a privacy boundary rather than
 * an optimisation. `Report` also holds `message` — the reporter's own words —
 * and `conversationSnapshot`, which is both parties' words copied off a
 * thread. Neither is validated past a length cap (`textLimits.ts` checks
 * length and nothing else), SCRUM-225 established that caller-supplied text
 * must not reach an email body, and SCRUM-621 built the immediate alert with
 * no user-authored value in it at all.
 *
 * Making the input type narrow is what keeps that true as this file changes.
 * A future edit cannot start summarising report text without first widening
 * this type, which is a visible decision rather than an accident.
 *
 * ## Why repeat subjects are counted and not named
 *
 * The ticket asked for repeat-report subjects to be highlighted, and this
 * reports **how many** users drew more than one report and **what the highest
 * count was**, without naming anybody or carrying an id.
 *
 * That is the deliberate reading of "highlight repeat subjects", because the
 * identity adds nothing an admin can act on from their inbox and costs
 * something real. The division SCRUM-621 established is that mail says
 * something needs attention and the authenticated dashboard is where it is
 * investigated; `/admin` already shows a per-row `reportsAboutUser` count, so
 * a name in the email would only move a reported person's identity — attached
 * to an accusation they have not been told about and cannot answer — into
 * staff mailboxes, forwarded inboxes and mail backups. The escalation signal
 * is the repetition, and the repetition survives anonymisation intact.
 *
 * Flipping this would mean adding an identifier to `DigestReportRow` and to
 * the template data, so it is a decision somebody has to make on purpose.
 */

/** The only two columns of a `Report` this aggregation may see. */
export type DigestReportRow = {
  reportedUserId: string;
  reason: ReportReason;
};

export type ReasonTally = {
  reason: ReportReason;
  label: string;
  count: number;
};

export type ReportDigestSummary = {
  /** Reports created inside the window. */
  reportCount: number;
  /** Distinct people those reports are about. */
  uniqueReportedUserCount: number;
  /** How many of those people drew more than one report this week. */
  repeatedReportedUserCount: number;
  /**
   * The largest number of reports about any one person this week. `0` when
   * there were no reports, so it is never compared against a missing value.
   */
  highestReportsAboutOneUser: number;
  /**
   * Reports whose reason already mailed the admins immediately. Included so
   * the digest reconciles with what staff saw during the week rather than
   * reading as a different, larger number from an unexplained source.
   */
  criticalReportCount: number;
  /**
   * Per-reason counts, in `REPORT_REASONS` order and omitting reasons with no
   * reports.
   *
   * Canonical order rather than count-descending, deliberately: a weekly
   * email is read by comparing it with last week's, and a list that reorders
   * itself makes that harder than a list with a fixed shape. It also puts
   * `SAFETY_CONCERN` first every week, which is the right thing to read first.
   */
  countsByReason: ReasonTally[];
};

/**
 * Counts a week of reports.
 *
 * An empty week is a real and expected result, not a missing one: every count
 * is `0` and `countsByReason` is empty. See `reportDigestSend.ts` for why a
 * digest is still sent in that case.
 */
export const summariseReports = (
  rows: readonly DigestReportRow[],
): ReportDigestSummary => {
  const perUser = new Map<string, number>();
  const perReason = new Map<ReportReason, number>();
  let criticalReportCount = 0;

  for (const row of rows) {
    perUser.set(row.reportedUserId, (perUser.get(row.reportedUserId) ?? 0) + 1);
    perReason.set(row.reason, (perReason.get(row.reason) ?? 0) + 1);

    if (isCriticalReportReason(row.reason)) {
      criticalReportCount += 1;
    }
  }

  const countsPerUser = [...perUser.values()];

  return {
    reportCount: rows.length,
    uniqueReportedUserCount: perUser.size,
    repeatedReportedUserCount: countsPerUser.filter((count) => count > 1)
      .length,
    // Spreading into `Math.max` would be `-Infinity` on an empty week, and
    // `Math.max(0, ...[])` is `0` — which is the value wanted, but reduce says
    // so without depending on that argument-order subtlety.
    highestReportsAboutOneUser: countsPerUser.reduce(
      (highest, count) => Math.max(highest, count),
      0,
    ),
    criticalReportCount,
    countsByReason: REPORT_REASONS.filter(
      (reason) => (perReason.get(reason) ?? 0) > 0,
    ).map((reason) => ({
      reason,
      label: REPORT_REASON_LABELS[reason],
      count: perReason.get(reason) ?? 0,
    })),
  };
};

/** What the digest says when a week produced no reports at all. */
export const NO_REPORTS_BREAKDOWN = "No reports this week";

/**
 * The per-reason breakdown as one line of text.
 *
 * Rendered here rather than looped over in the template because SES templates
 * take a single flat `TemplateData` blob and every existing template in
 * `scripts/emailtemplate.py` uses plain substitution only. Keeping that true
 * means the digest needs no template feature the other six do not already
 * rely on, and the formatting stays somewhere `yarn test` can see it.
 */
export const formatReasonBreakdown = (summary: ReportDigestSummary): string => {
  if (summary.countsByReason.length === 0) {
    return NO_REPORTS_BREAKDOWN;
  }

  return summary.countsByReason
    .map((tally) => `${tally.label}: ${tally.count}`)
    .join(", ");
};
