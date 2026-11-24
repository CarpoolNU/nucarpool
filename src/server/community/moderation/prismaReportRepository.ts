import type { TargetType } from "../content/public";
import { URGENT_REPORT_REASONS } from "./domain/urgency";
import type {
  ListReportsQuery,
  ReportRepository,
  ReportStatus,
  StoredReport,
  TargetReportCounts,
} from "./ports";

/**
 * The delegate a report touches.
 *
 * **No `$transaction`, unlike {@link VoteStore}.** Every write here is one
 * statement against one row or one target's rows, and the only things that
 * arbitrate are the unique triple and a `WHERE` clause — neither needs a lock
 * held across two statements.
 *
 * `findMany` is declared once and called twice; the `select` in `countsFor`
 * narrows what actually comes back to `reporterId` and `status`, which are the
 * only fields that call reads.
 */
export type ReportStore = {
  communityReport: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    findUnique(args: Record<string, unknown>): Promise<StoredReport | null>;
    findMany(args: Record<string, unknown>): Promise<StoredReport[]>;
    count(args: Record<string, unknown>): Promise<number>;
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
};

/**
 * Prisma's unique-constraint error, narrowed to the one index that matters
 * here.
 *
 * `community_report` has exactly one unique index,
 * `@@unique([reporterId, targetType, targetId])`, so a P2002 on this insert can
 * mean nothing else.
 */
const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "P2002";

export class PrismaReportRepository implements ReportRepository {
  constructor(private readonly store: ReportStore) {}

  /**
   * Files a report, or amends the reporter's existing one.
   *
   * **It does not ask whether this reporter has already reported the target.**
   * The insert goes straight at the unique triple and a duplicate-key error
   * *is* the answer, so two concurrent submissions of the same report cannot
   * both pass a check and both insert — the loser lands in the update instead
   * of an unhandled database fault.
   *
   * **The update names `reason` and `message` and nothing else, and that
   * omission is the guarantee.** `status`, `reviewedById`, `contentSnapshot`
   * and `dateCreated` are the first report's. Adding `status: "OPEN"` here
   * would let a reporter re-queue something a moderator already dismissed,
   * which is exactly what the port forbids; replacing the snapshot would let a
   * later report overwrite the evidence of what the content said when it was
   * first reported. `FakeReportRepository` makes the same two writes and no
   * others.
   */
  async upsert(
    input: Omit<StoredReport, "id" | "status" | "reviewedById" | "reviewNote">,
  ): Promise<"created" | "updated"> {
    try {
      await this.store.communityReport.create({ data: input });
      return "created";
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    // The count is not checked: the P2002 proved the row exists, and "hide,
    // never delete" is what keeps it there. A future delete path would turn
    // this silent "updated" into a lost report.
    await this.store.communityReport.updateMany({
      where: {
        reporterId: input.reporterId,
        targetType: input.targetType,
        targetId: input.targetId,
      },
      data: { reason: input.reason, message: input.message },
    });
    return "updated";
  }

  /**
   * What the auto-hide decision needs, in one query.
   *
   * **One `findMany` rather than a `count` and an `exists`**, because two
   * queries would be two round trips for one decision. It is served by
   * `@@index([targetType, targetId])` and selects only `reporterId` and
   * `status`; the distinct count and the dismissed and reviewed flags are
   * computed from the rows. The unique triple already means a reporter has at
   * most one row per target, but the `Set` states what is being counted rather
   * than leaning on that.
   */
  async countsFor(
    targetType: TargetType,
    targetId: string,
  ): Promise<TargetReportCounts> {
    const rows = await this.store.communityReport.findMany({
      where: { targetType, targetId },
      select: { reporterId: true, status: true },
    });

    return {
      distinctOpenReporters: new Set(
        rows
          .filter((row) => row.status === "OPEN")
          .map((row) => row.reporterId),
      ).size,
      hasDismissedReport: rows.some((row) => row.status === "DISMISSED"),
      hasReviewedReport: rows.some((row) => row.status === "REVIEWED"),
    };
  }

  async findById(reportId: string): Promise<StoredReport | null> {
    return this.store.communityReport.findUnique({ where: { id: reportId } });
  }

  /**
   * One keyset page of the queue, newest first.
   *
   * **The `OR` is the tuple comparison `(dateCreated, id) < (?, ?)`** written
   * the way Prisma can express it, served by `@@index([status, dateCreated])`.
   * That index carries no trailing `id`, so the tiebreak is the primary key in
   * the `ORDER BY`, and it is load-bearing: a burst of reports on one target
   * lands in the same millisecond, and without a total order a page boundary
   * inside that run would drop or repeat one.
   */
  async list(query: ListReportsQuery): Promise<readonly StoredReport[]> {
    const after = query.after;

    return this.store.communityReport.findMany({
      where: {
        status: query.status,
        // A filter over the range `@@index([status, dateCreated])` already
        // narrowed, not a seek of its own: `reason` is not in that index, so
        // these rows are read and then discarded. That is the same accepted
        // trade as search's `LIKE` (spec §16.2), and it is bounded by the
        // status filter running first — the OPEN set is the queue, which is
        // small by definition, because a queue that is not small is the
        // problem this feature exists to surface.
        ...(query.urgentOnly
          ? { reason: { in: [...URGENT_REPORT_REASONS] } }
          : {}),
        ...(after
          ? {
              OR: [
                { dateCreated: { lt: after.dateCreated } },
                { dateCreated: after.dateCreated, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
      take: query.limit,
    });
  }

  /**
   * How many open reports are urgent.
   *
   * **A `count`, not a `findMany` whose length is taken**, which is the
   * opposite call from {@link countsFor} above and for a reason worth stating:
   * that one needs the rows, because it computes three different things from
   * them and a second query would be a second round trip for one decision.
   * This needs the number alone, and the rows it would otherwise read are the
   * whole open urgent queue — unbounded in exactly the situation where the
   * count matters most.
   *
   * Served by `@@index([status, dateCreated])` for the status, with `reason`
   * filtered over that range as in {@link list}.
   */
  async countOpenUrgent(): Promise<number> {
    return this.store.communityReport.count({
      where: { status: "OPEN", reason: { in: [...URGENT_REPORT_REASONS] } },
    });
  }

  /**
   * Resolves one report, once.
   *
   * **The `status: "OPEN"` in the `WHERE` is the whole concurrency guard.**
   * There is no read before this write. `src/server/db/blocks.ts` documents a
   * related hazard: inside an interactive transaction a plain `SELECT` answers
   * from the REPEATABLE READ snapshot, so a row another transaction commits
   * afterwards stays invisible. **This method has no transaction, so its
   * hazard is the plainer one, check-then-act**: a read that says "still open"
   * is true of a report a second moderator resolves before this write lands.
   * The remedy differs accordingly. `blocks.ts` takes a locking read
   * (`FOR UPDATE`, as `lockPostForUpdate` does for a comment's parent), because
   * its check and its write are separate statements and the lock must be held
   * across both. Here the condition can ride on the write itself, so no lock
   * and no second statement are needed: the predicate is evaluated by the same
   * statement that writes, and exactly one of two racing moderators matches the
   * row while the other gets `count === 0`.
   * `updateMany` rather than `update`, because `update` throws on no match
   * where "somebody else got there first" is an ordinary answer.
   *
   * It also keeps the first verdict's reviewer and note: a second resolve
   * matches nothing, so it cannot overwrite them.
   */
  async resolve(input: {
    reportId: string;
    status: Exclude<ReportStatus, "OPEN">;
    reviewedById: string;
    reviewNote: string | null;
  }): Promise<boolean> {
    const { count } = await this.store.communityReport.updateMany({
      where: { id: input.reportId, status: "OPEN" },
      data: {
        status: input.status,
        reviewedById: input.reviewedById,
        reviewNote: input.reviewNote,
      },
    });
    return count === 1;
  }

  /**
   * Resolves every other OPEN report on one target, in one statement.
   *
   * **The same guard as {@link resolve}**: `status: "OPEN"` in the `WHERE`
   * means a sibling a moderator resolved separately keeps its own verdict and
   * note. `id: { not: exceptReportId }` leaves the report the caller just
   * resolved with the note it was given. The note is not written, matching
   * `FakeReportRepository`, so a sibling closed by this sweep carries a
   * reviewer and no note of its own.
   */
  async resolveSiblings(input: {
    targetType: TargetType;
    targetId: string;
    exceptReportId: string;
    status: Exclude<ReportStatus, "OPEN">;
    reviewedById: string;
  }): Promise<number> {
    const { count } = await this.store.communityReport.updateMany({
      where: {
        targetType: input.targetType,
        targetId: input.targetId,
        status: "OPEN",
        id: { not: input.exceptReportId },
      },
      data: { status: input.status, reviewedById: input.reviewedById },
    });
    return count;
  }
}
