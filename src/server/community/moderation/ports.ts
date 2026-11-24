import type { TargetType } from "../content/public";
import type { NewCursor } from "../shared/cursor";

export type ReportReason =
  | "HARASSMENT"
  | "SPAM"
  | "MISINFORMATION"
  | "OFF_TOPIC"
  | "SAFETY_CONCERN"
  | "OTHER";

export type ReportStatus = "OPEN" | "REVIEWED" | "DISMISSED";

/**
 * A report as the repository holds it, ids and all.
 *
 * **This is the unpublished shape.** It carries `reporterId` and
 * `reportedUserId` because the service needs them to enforce the rules; the
 * published shape is `QueuedReport`, which has neither.
 */
export type StoredReport = {
  id: string;
  reporterId: string;
  reportedUserId: string;
  targetType: TargetType;
  targetId: string;
  reason: ReportReason;
  message: string | null;
  contentSnapshot: string | null;
  status: ReportStatus;
  reviewedById: string | null;
  reviewNote: string | null;
  dateCreated: Date;
};

/**
 * A page of the moderator queue. The cursor is the `NewCursor` shape because
 * the index it pages over is `@@index([status, dateCreated])` — and that index
 * carries no trailing `id`, so the tiebreak is the primary key, applied in the
 * `ORDER BY`, not something the index provides.
 */
export type ListReportsQuery = {
  status: ReportStatus;
  after: NewCursor | null;
  limit: number;
  /**
   * Narrows to the reasons `isUrgentReportReason` calls urgent.
   *
   * **A filter, not a sort, and that is the whole of what urgency does to this
   * query.** Ordering urgent reports first would mean urgency in
   * `@@index([status, dateCreated])` — a schema change, a migration, and a
   * third cursor shape beside `new` and `top`. A `reason IN (...)` predicate
   * rides the existing index and leaves `after` meaning exactly what it meant
   * before, so a cursor issued under one filter is still a point in the same
   * `(dateCreated, id)` order.
   *
   * **It is orthogonal to `status`.** Urgency says what kind of report this
   * is; status says what has been done about it. A reviewed safety report is
   * still a safety report, so the two compose rather than one overriding the
   * other.
   */
  urgentOnly: boolean;
};

export type TargetReportCounts = {
  /** Distinct reporters who have an OPEN report on the target. */
  distinctOpenReporters: number;
  /** Whether any report on the target has ever been dismissed. */
  hasDismissedReport: boolean;
  /**
   * Whether any report on the target has ever been `REVIEWED`.
   *
   * **This is how a hide is told to be automatic.** `REVIEWED` is written by
   * exactly one path: a moderator's `HIDE`, which also resolves every sibling
   * through `resolveSiblings`. An auto-hide resolves nothing. So a hidden
   * target with no `REVIEWED` report on it was hidden by the threshold, and one
   * with a `REVIEWED` report was hidden by a person. `ModerationService.review`
   * reads this to decide whether a `DISMISS` may restore the target, and it is
   * an inference over report statuses rather than a recorded fact: `hiddenAt`
   * says when a post went down, not who took it down. If `REVIEWED` ever gains
   * a second writer, or a moderator hide stops resolving siblings, this stops
   * meaning what it says.
   */
  hasReviewedReport: boolean;
};

/**
 * The persistence contract for reports.
 *
 * **Every method reports what the database decided, not what the caller
 * intended**, as in `VoteRepository`. Two things arbitrate, and neither is a
 * prior read: the `@@unique([reporterId, targetType, targetId])` triple decides
 * whether a report is new, and a conditional `UPDATE ... WHERE status =
 * 'OPEN'` decides who resolved it. A "has this been reported?" or "is this
 * still open?" read ahead of either leaves a window in which two concurrent
 * requests both pass the check.
 */
export interface ReportRepository {
  /**
   * Insert-first; the unique triple is the arbiter. An existing row has its
   * reason and message updated and its status left alone.
   *
   * **`upsert` never changes `status`.** A reporter who re-reports something a
   * moderator has already reviewed must not be able to re-queue it: if a
   * repeat report reopened the row, one determined person could keep a
   * dismissed report in the queue indefinitely and occupy the moderator's
   * attention. The reporter may still correct what they said; the verdict
   * stands.
   */
  upsert(
    input: Omit<StoredReport, "id" | "status" | "reviewedById" | "reviewNote">,
  ): Promise<"created" | "updated">;

  countsFor(
    targetType: TargetType,
    targetId: string,
  ): Promise<TargetReportCounts>;

  findById(reportId: string): Promise<StoredReport | null>;

  /** Newest first, by `(dateCreated, id)`, for one status. */
  list(query: ListReportsQuery): Promise<readonly StoredReport[]>;

  /**
   * How many OPEN reports carry an urgent reason.
   *
   * **The one aggregate in this port, and it is deliberately not a general
   * one.** It takes no arguments because there is exactly one question a
   * moderator needs answered without paging for it — "is something urgent
   * waiting?" — and a `countReports(filter)` would invite the queue to start
   * reporting totals it cannot cheaply produce. `OPEN` is baked in for the
   * same reason the count exists: a resolved safety report is not waiting on
   * anyone, so counting it would make the number mean something no moderator
   * wants.
   */
  countOpenUrgent(): Promise<number>;

  /**
   * Conditional on `status = 'OPEN'`. Returns whether this caller won.
   *
   * A `false` means the report is absent or somebody else resolved it first;
   * the caller learns which by what it does next, not from this method.
   */
  resolve(input: {
    reportId: string;
    status: Exclude<ReportStatus, "OPEN">;
    reviewedById: string;
    reviewNote: string | null;
  }): Promise<boolean>;

  /** Resolves every other OPEN report on one target. Returns how many moved. */
  resolveSiblings(input: {
    targetType: TargetType;
    targetId: string;
    exceptReportId: string;
    status: Exclude<ReportStatus, "OPEN">;
    reviewedById: string;
  }): Promise<number>;
}
