/**
 * The weekly digest's aggregation.
 *
 * Pure counting, so these are table tests over hand-built rows. What the
 * numbers then become — `TemplateData`, recipients, the delivery claim — is
 * covered in `emailParams.test.ts`, `reportDigestSend.test.ts` and
 * `db/reportDigestDelivery.db.test.ts`.
 */

import { ReportReason } from "@prisma/client";
import {
  formatReasonBreakdown,
  NO_REPORTS_BREAKDOWN,
  summariseReports,
  type DigestReportRow,
} from "./reportDigest";
import { REPORT_REASONS } from "../utils/reports";

/** `count` reports about one user, all for the same reason. */
const reportsAbout = (
  reportedUserId: string,
  count: number,
  reason: ReportReason = ReportReason.NO_SHOW,
): DigestReportRow[] =>
  Array.from({ length: count }, () => ({ reportedUserId, reason }));

describe("summariseReports", () => {
  /**
   * An empty week is a real result rather than a missing one, and every count
   * has to be a number so that nothing downstream formats `undefined` into an
   * email. `highestReportsAboutOneUser` is the one at risk: spreading an empty
   * array into `Math.max` gives `-Infinity`.
   */
  it("reports all zeroes for a week with no reports", () => {
    expect(summariseReports([])).toEqual({
      reportCount: 0,
      uniqueReportedUserCount: 0,
      repeatedReportedUserCount: 0,
      highestReportsAboutOneUser: 0,
      criticalReportCount: 0,
      countsByReason: [],
    });
  });

  it("counts a single report", () => {
    expect(summariseReports(reportsAbout("user-a", 1))).toEqual({
      reportCount: 1,
      uniqueReportedUserCount: 1,
      repeatedReportedUserCount: 0,
      highestReportsAboutOneUser: 1,
      criticalReportCount: 0,
      countsByReason: [
        { reason: ReportReason.NO_SHOW, label: "Didn't show up", count: 1 },
      ],
    });
  });

  /**
   * The signal the digest exists to surface. Three users, one of whom drew
   * three reports and one two, so `repeatedReportedUserCount` has to count
   * users rather than reports and `highestReportsAboutOneUser` has to be the
   * maximum rather than the total or the mean.
   */
  it("separates repeat subjects from one-off reports", () => {
    const summary = summariseReports([
      ...reportsAbout("user-a", 3),
      ...reportsAbout("user-b", 2),
      ...reportsAbout("user-c", 1),
    ]);

    expect(summary.reportCount).toBe(6);
    expect(summary.uniqueReportedUserCount).toBe(3);
    expect(summary.repeatedReportedUserCount).toBe(2);
    expect(summary.highestReportsAboutOneUser).toBe(3);
  });

  it("does not count a single-report user as a repeat subject", () => {
    const summary = summariseReports([
      ...reportsAbout("user-a", 1),
      ...reportsAbout("user-b", 1),
    ]);

    expect(summary.uniqueReportedUserCount).toBe(2);
    expect(summary.repeatedReportedUserCount).toBe(0);
    expect(summary.highestReportsAboutOneUser).toBe(1);
  });

  /**
   * Several reasons about one person is still one repeat subject. The count is
   * over people, and nothing about the reasons should change that.
   */
  it("treats differing reasons about one person as one repeat subject", () => {
    const summary = summariseReports([
      { reportedUserId: "user-a", reason: ReportReason.NO_SHOW },
      { reportedUserId: "user-a", reason: ReportReason.FAKE_PROFILE },
    ]);

    expect(summary.uniqueReportedUserCount).toBe(1);
    expect(summary.repeatedReportedUserCount).toBe(1);
    expect(summary.highestReportsAboutOneUser).toBe(2);
  });

  /**
   * The digest is the complete picture of the week, so a report that already
   * mailed the admins on filing is counted here too — and counted again in
   * `criticalReportCount`, so an admin can reconcile the digest with the
   * alerts they saw rather than wondering where an extra report came from.
   */
  it("includes critical reports in the totals and counts them separately", () => {
    const summary = summariseReports([
      { reportedUserId: "user-a", reason: ReportReason.SAFETY_CONCERN },
      { reportedUserId: "user-b", reason: ReportReason.NO_SHOW },
      { reportedUserId: "user-c", reason: ReportReason.HARASSMENT },
    ]);

    expect(summary.reportCount).toBe(3);
    expect(summary.criticalReportCount).toBe(1);
  });

  it("counts no critical reports when the week had none", () => {
    expect(
      summariseReports(reportsAbout("user-a", 2, ReportReason.OTHER))
        .criticalReportCount,
    ).toBe(0);
  });

  /**
   * Canonical order, not count-descending: a weekly email is read against last
   * week's, and a list that reorders itself makes that harder. It also puts
   * `SAFETY_CONCERN` first every week.
   */
  it("orders reasons canonically rather than by count", () => {
    const summary = summariseReports([
      ...reportsAbout("user-a", 5, ReportReason.OTHER),
      { reportedUserId: "user-b", reason: ReportReason.SAFETY_CONCERN },
    ]);

    expect(summary.countsByReason.map((tally) => tally.reason)).toEqual([
      ReportReason.SAFETY_CONCERN,
      ReportReason.OTHER,
    ]);
  });

  it("omits reasons nobody chose", () => {
    const summary = summariseReports(reportsAbout("user-a", 1));

    expect(summary.countsByReason).toHaveLength(1);
    expect(summary.countsByReason.map((tally) => tally.reason)).not.toContain(
      ReportReason.SAFETY_CONCERN,
    );
  });

  /**
   * Every reason has to survive the aggregation, so a reason added to the
   * schema cannot be silently dropped from the digest. Driven off
   * `REPORT_REASONS` rather than a hand-written list, and the length assertion
   * stops it passing as an empty sweep.
   */
  it("counts every reason the schema defines", () => {
    expect(REPORT_REASONS.length).toBeGreaterThanOrEqual(6);

    const summary = summariseReports(
      REPORT_REASONS.map((reason, index) => ({
        reportedUserId: `user-${index}`,
        reason,
      })),
    );

    expect(summary.countsByReason).toHaveLength(REPORT_REASONS.length);
    expect(summary.countsByReason.map((tally) => tally.reason)).toEqual(
      REPORT_REASONS,
    );
    expect(summary.countsByReason.every((tally) => tally.count === 1)).toBe(
      true,
    );
  });

  /**
   * Labels come from `REPORT_REASON_LABELS` rather than being re-spelled, so
   * the digest and the admin queue cannot describe the same report
   * differently. Asserted against literal copy, which is what makes this a
   * check rather than a restatement.
   */
  it("labels reasons the way the rest of the app does", () => {
    const summary = summariseReports([
      { reportedUserId: "user-a", reason: ReportReason.SAFETY_CONCERN },
      { reportedUserId: "user-b", reason: ReportReason.INAPPROPRIATE_MESSAGES },
    ]);

    expect(summary.countsByReason.map((tally) => tally.label)).toEqual([
      "Safety concern",
      "Inappropriate messages",
    ]);
  });
});

describe("formatReasonBreakdown", () => {
  it("says so explicitly when there were no reports", () => {
    expect(formatReasonBreakdown(summariseReports([]))).toBe(
      NO_REPORTS_BREAKDOWN,
    );
    // The copy has to read as a sentence in an email, not as an empty string
    // or a bare zero.
    expect(NO_REPORTS_BREAKDOWN).toMatch(/no reports/i);
  });

  it("lists each reason with its count", () => {
    const summary = summariseReports([
      { reportedUserId: "user-a", reason: ReportReason.SAFETY_CONCERN },
      ...reportsAbout("user-b", 2, ReportReason.NO_SHOW),
    ]);

    expect(formatReasonBreakdown(summary)).toBe(
      "Safety concern: 1, Didn't show up: 2",
    );
  });

  /**
   * The breakdown is interpolated into both parts of the email, so it must not
   * contain anything a reader would see as markup. Every label is a string
   * this repository wrote, and this pins that it stays that way.
   */
  it("produces no characters needing HTML escaping", () => {
    const summary = summariseReports(
      REPORT_REASONS.map((reason, index) => ({
        reportedUserId: `user-${index}`,
        reason,
      })),
    );

    expect(formatReasonBreakdown(summary)).not.toMatch(/[<>&"]/);
  });
});
