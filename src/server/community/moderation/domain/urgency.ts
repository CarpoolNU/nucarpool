/**
 * Which report reasons cannot wait their turn in the queue.
 *
 * **The reporter already chose from six fixed reasons**, so the severity of a
 * report is a product decision over that enum and not a second thing to store.
 * `CommunityReport` has no urgency column and does not need one: a column
 * would be a second source of truth that a reason change could desync, and
 * adding it would be a migration for a value that is a pure function of a
 * column already there.
 *
 * **This mirrors `REPORT_URGENCY` in the host repo** (`src/utils/reports.ts`),
 * which makes the same call for carpool's own reports, and for the same
 * stated reason: one map beside the labels rather than a rule spread across
 * the paths that consult it. Reclassifying a reason is a one-line edit here.
 *
 * **The buckets are `IMMEDIATE` and `ROUTINE`, where the host's are
 * `IMMEDIATE` and `DIGEST`, and the difference is deliberate.** The host's
 * `DIGEST` names a real thing — a weekly mail job that routine reports are
 * counted into. Community has no mail path and no digest, so calling the
 * second bucket `DIGEST` would name a mechanism that does not exist and
 * promise a delivery nobody wrote. `ROUTINE` says only what is true: these
 * wait for a moderator to open the queue.
 *
 * **Nothing here sends anything.** Spec §17.8 asks whether a community
 * `SAFETY_CONCERN` should page admins the way carpool's does, and that
 * question is still open and still needs an owner. What this file settles is
 * the smaller half: a safety report is now *distinguishable*, so a moderator
 * can find it. Whether it should also interrupt someone is the part that
 * remains undecided.
 */
import type { ReportReason } from "../ports";

export type ReportUrgency = "IMMEDIATE" | "ROUTINE";

/**
 * Every reason, bucketed.
 *
 * **A `Record` over the union, not a list of the urgent ones**, which is the
 * property the whole file rests on: a reason added to `ReportReason` fails the
 * type check here until somebody decides which bucket it belongs in. A
 * `ReadonlyArray<ReportReason>` of the urgent ones would accept any subset, so
 * a new reason would silently default to routine and nothing would go red —
 * and defaulting a reason to "can wait" is the wrong way for this particular
 * mistake to fall. `REPORT_REASON_LABELS` in the host repo and
 * `reportReasons.ts` beside the picker rely on the same guard.
 *
 * `SAFETY_CONCERN` is the only `IMMEDIATE` one. It is what a student picks
 * when they felt unsafe, and the rest describe something that has already
 * happened and that a moderator acts on by reading the queue.
 */
export const REPORT_URGENCY: Record<ReportReason, ReportUrgency> = {
  SAFETY_CONCERN: "IMMEDIATE",
  HARASSMENT: "ROUTINE",
  SPAM: "ROUTINE",
  MISINFORMATION: "ROUTINE",
  OFF_TOPIC: "ROUTINE",
  OTHER: "ROUTINE",
};

/** Whether a report filed for this reason should be surfaced ahead of the queue. */
export const isUrgentReportReason = (reason: ReportReason): boolean =>
  REPORT_URGENCY[reason] === "IMMEDIATE";

/**
 * The urgent reasons, as a list.
 *
 * **Derived from the map rather than written out**, so the `reason IN (...)`
 * predicate the repository builds from it cannot drift from the predicate the
 * published `urgent` flag is computed with. A query that selected a different
 * set from the one the badge marks would be the worst version of this feature:
 * a filtered queue that omits a report the moderator was told exists.
 */
export const URGENT_REPORT_REASONS: ReadonlyArray<ReportReason> = (
  Object.keys(REPORT_URGENCY) as ReportReason[]
).filter(isUrgentReportReason);
