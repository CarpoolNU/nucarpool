import type {
  ListReportsQuery,
  ReportRepository,
  ReportStatus,
  StoredReport,
  TargetReportCounts,
} from "../moderation/ports";
import type { TargetType } from "../content/public";
import { isUrgentReportReason } from "../moderation/domain/urgency";

/**
 * In-memory `ReportRepository`.
 *
 * **It enforces the unique triple rather than trusting the service**, the same
 * reasoning `FakeSavedPostRepository` gives for its pair. The
 * `(reporterId, targetType, targetId)` triple is the entire idempotency
 * guarantee, so a fake that let a second insert through would make `report`
 * look idempotent while the real index was the only thing making it so — and
 * the service would pass its tests while shipping a duplicate row to MySQL.
 *
 * **It reproduces the real ordering, including the `id` tiebreak.** The index
 * is `@@index([status, dateCreated])` with no trailing `id`, so the database
 * orders ties by the primary key only because the query asks it to, and a
 * keyset page boundary is exactly where a non-total order drops or repeats a
 * row. Reports filed in the same millisecond are what a burst of reporting
 * produces.
 *
 * **`resolve` is conditional on the stored status**, so a second call returns
 * `false` — the in-memory shape of `UPDATE ... WHERE status = 'OPEN'`.
 */
export class FakeReportRepository implements ReportRepository {
  rows: StoredReport[] = [];

  private nextId = 1;

  async upsert(
    input: Omit<StoredReport, "id" | "status" | "reviewedById" | "reviewNote">,
  ): Promise<"created" | "updated"> {
    const existing = this.rows.find(
      (row) =>
        row.reporterId === input.reporterId &&
        row.targetType === input.targetType &&
        row.targetId === input.targetId,
    );

    if (existing) {
      // Reason and message only. Status, snapshot and date are the first
      // report's, and a repeat must not re-queue a reviewed one.
      existing.reason = input.reason;
      existing.message = input.message;
      return "updated";
    }

    this.rows.push({
      ...input,
      id: `report-${String(this.nextId++).padStart(3, "0")}`,
      status: "OPEN",
      reviewedById: null,
      reviewNote: null,
    });
    return "created";
  }

  async countsFor(
    targetType: TargetType,
    targetId: string,
  ): Promise<TargetReportCounts> {
    const onTarget = this.rows.filter(
      (row) => row.targetType === targetType && row.targetId === targetId,
    );

    return {
      distinctOpenReporters: new Set(
        onTarget
          .filter((row) => row.status === "OPEN")
          .map((row) => row.reporterId),
      ).size,
      hasDismissedReport: onTarget.some((row) => row.status === "DISMISSED"),
      hasReviewedReport: onTarget.some((row) => row.status === "REVIEWED"),
    };
  }

  async findById(reportId: string): Promise<StoredReport | null> {
    return this.rows.find((row) => row.id === reportId) ?? null;
  }

  async list(query: ListReportsQuery): Promise<readonly StoredReport[]> {
    const ordered = this.rows
      .filter(
        (row) =>
          row.status === query.status &&
          // The same predicate the real `reason IN (...)` is built from, by
          // way of the same exported list, so the two cannot select different
          // sets.
          (!query.urgentOnly || isUrgentReportReason(row.reason)),
      )
      .sort(
        (a, b) =>
          b.dateCreated.getTime() - a.dateCreated.getTime() ||
          b.id.localeCompare(a.id),
      );

    const after = query.after;
    const page = after
      ? ordered.filter(
          (row) =>
            row.dateCreated.getTime() < after.dateCreated.getTime() ||
            (row.dateCreated.getTime() === after.dateCreated.getTime() &&
              row.id.localeCompare(after.id) < 0),
        )
      : ordered;

    return page.slice(0, query.limit);
  }

  /** `OPEN` and urgent, as the real `count` scopes it. */
  async countOpenUrgent(): Promise<number> {
    return this.rows.filter(
      (row) => row.status === "OPEN" && isUrgentReportReason(row.reason),
    ).length;
  }

  async resolve(input: {
    reportId: string;
    status: Exclude<ReportStatus, "OPEN">;
    reviewedById: string;
    reviewNote: string | null;
  }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === input.reportId);
    if (!row || row.status !== "OPEN") {
      return false;
    }

    row.status = input.status;
    row.reviewedById = input.reviewedById;
    row.reviewNote = input.reviewNote;
    return true;
  }

  async resolveSiblings(input: {
    targetType: TargetType;
    targetId: string;
    exceptReportId: string;
    status: Exclude<ReportStatus, "OPEN">;
    reviewedById: string;
  }): Promise<number> {
    const siblings = this.rows.filter(
      (row) =>
        row.targetType === input.targetType &&
        row.targetId === input.targetId &&
        row.id !== input.exceptReportId &&
        row.status === "OPEN",
    );

    for (const row of siblings) {
      row.status = input.status;
      row.reviewedById = input.reviewedById;
    }
    return siblings.length;
  }
}
