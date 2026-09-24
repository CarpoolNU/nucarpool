import { ReportReason } from "@prisma/client";

/**
 * What each `ReportReason` is called on screen (SCRUM-555). One map for the
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
