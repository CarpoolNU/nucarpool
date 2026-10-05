import { ReportReason, ReportStatus } from "@prisma/client";

/**
 * What each `ReportReason` is called on screen. One map for the
 * reporter's select and the admin queue, so the two cannot describe the same
 * report differently.
 *
 * A `Record` over the enum, so a reason added to the schema fails the type
 * check here until it has a label.
 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SAFETY_CONCERN: "Safety concern",
  HARASSMENT: "Harassment",
  INAPPROPRIATE_MESSAGES: "Inappropriate messages",
  FAKE_PROFILE: "Fake profile",
  NO_SHOW: "Didn't show up",
  OTHER: "Something else",
};

/**
 * What each `ReportStatus` is called **to the person who filed the report**.
 *
 * Separate from the admin queue's filter chips in `AdminReports`, which name
 * the same three states but answer a different question: there they label a
 * slice of a queue, here they tell one reporter where their own submission
 * stands. "Awaiting review" is the whole difference, and it is the one that
 * matters - `OPEN` is a queue word, and a reporter reading it about their own
 * report cannot tell "nobody has looked yet" from "looked at, no action".
 *
 * `REVIEWED` and `DISMISSED` keep the admin's words deliberately. They are
 * blunt, and softening either one would describe a decision that was not
 * made.
 *
 * A `Record` over the enum, so a status added to the schema fails the type
 * check here until it has a label.
 */
export const REPORTER_STATUS_LABELS: Record<ReportStatus, string> = {
  OPEN: "Awaiting review",
  REVIEWED: "Reviewed",
  DISMISSED: "Dismissed",
};

/** The reasons in the order the select offers them. */
export const REPORT_REASONS = Object.keys(
  REPORT_REASON_LABELS,
) as ReportReason[];

/**
 * How many of the most recent messages a report made from a conversation
 * keeps. Here rather than beside the snapshot builder in `src/server/`, because
 * the report dialog tells the reporter the number.
 */
export const REPORT_SNAPSHOT_MESSAGE_LIMIT = 50;
