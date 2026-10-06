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

/**
 * Whether a reason earns mail the moment it is filed, or waits for the weekly
 * digest.
 *
 * **This classifies the reasons that already exist; it is not a new severity
 * system.** `Report` has no severity column and does not need one: the
 * reporter already chose from six fixed reasons, and which of those cannot
 * wait a week is a product decision with one correct home — here, beside the
 * labels, rather than spread across the send path.
 *
 * `SAFETY_CONCERN` is the only `IMMEDIATE` one. It is the reason a student
 * picks when they felt unsafe in a car with someone, and a week is not an
 * acceptable delay for that. Everything else describes something that has
 * already happened and that an admin acts on by reading the queue:
 *
 *  - `HARASSMENT` and `INAPPROPRIATE_MESSAGES` are serious, and they are the
 *    judgement call in this map. They are `DIGEST` because the app already
 *    gives the reporter the immediate remedy: `reports.create` blocks the
 *    other user in the same submission when `alsoBlock` is set, which stops
 *    the contact at once without waiting for staff. A faster admin email
 *    would not reach the reporter any sooner.
 *  - `FAKE_PROFILE`, `NO_SHOW` and `OTHER` are queue items by nature.
 *
 * **Reclassifying one is a one-line change here** and nothing else, which is
 * the point of keeping it in a single map. If the team decides harassment
 * should interrupt someone, move it and the immediate path picks it up.
 *
 * A `Record` over the enum, so a reason added to the schema fails the type
 * check until somebody decides which bucket it belongs in — the same property
 * `REPORT_REASON_LABELS` relies on, and the reason this is a map rather than
 * an array of just the critical ones.
 */
export type ReportUrgency = "IMMEDIATE" | "DIGEST";

export const REPORT_URGENCY: Record<ReportReason, ReportUrgency> = {
  SAFETY_CONCERN: "IMMEDIATE",
  HARASSMENT: "DIGEST",
  INAPPROPRIATE_MESSAGES: "DIGEST",
  FAKE_PROFILE: "DIGEST",
  NO_SHOW: "DIGEST",
  OTHER: "DIGEST",
};

/**
 * Whether filing this reason mails the admins straight away.
 *
 * The one predicate `reports.create` consults. A critical report is **also**
 * counted in the weekly digest — the digest is the complete picture of a week,
 * not the leftovers — so this decides whether an extra immediate alert goes
 * out, never whether the report reaches admins at all.
 */
export const isCriticalReportReason = (reason: ReportReason): boolean =>
  REPORT_URGENCY[reason] === "IMMEDIATE";

/** The reasons that mail admins immediately. For the digest copy and tests. */
export const CRITICAL_REPORT_REASONS = REPORT_REASONS.filter(
  isCriticalReportReason,
);
