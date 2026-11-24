import type { TargetType } from "../content/public";
import { isUrgentReportReason } from "./domain/urgency";
import type { ReportReason, ReportStatus, StoredReport } from "./ports";

export type { ReportReason, ReportStatus } from "./ports";

/**
 * What a reporter is told after filing.
 *
 * **It acknowledges and nothing else**, so filing a first report, correcting
 * an earlier one, and re-reporting something already reviewed all look the
 * same from outside. A richer reply — "already reported", "already reviewed",
 * how many others agree — would let a reporter probe the state of the queue.
 */
export type ReportReceipt = { acknowledged: true };

/**
 * A report as a moderator sees it in the queue.
 *
 * **This type has no reporter, in any form** — no `reporterId`, no handle, no
 * count of who. §13.4 forbids showing a reporter to the reported party, and in
 * a community this small a moderator who can see reporter handles is one
 * conversation away from the same exposure. Mass-reporting is bounded by the
 * `REPORT_CREATE` budget and by the unique triple instead, which needs no
 * knowledge of who filed. Nor does it carry `reportedUserId` or `authorId`:
 * identity cannot leak by someone forgetting to strip a field, because adding
 * one means editing a file whose name says it is the boundary (spec §13.1).
 *
 * What it does carry is public already. `reportedHandle` is a handle, which
 * anyone can see on the post, and `targetId` is in the URL.
 */
export type QueuedReport = {
  id: string;
  targetType: TargetType;
  targetId: string;
  reason: ReportReason;
  message: string | null;
  contentSnapshot: string | null;
  status: ReportStatus;
  reportedHandle: string;
  dateCreated: Date;
  /**
   * Whether this report's reason is one that should not wait its turn.
   *
   * **Derived from `reason`, never stored.** `REPORT_URGENCY` is the single
   * place that decides, so there is no row that can disagree with the map and
   * no migration behind reclassifying a reason. It is published rather than
   * left for the client to compute because the rule belongs to the domain: a
   * page that applied its own idea of which reasons are urgent would be a
   * second copy of a product decision, and the one in the browser is the copy
   * that gets it wrong.
   */
  urgent: boolean;
};

export type ReportQueuePage = {
  reports: QueuedReport[];
  nextCursor: string | null;
  /**
   * Open urgent reports across the whole queue, or `null` on a cursored page.
   *
   * **It is not a count of this page**, and on purpose: its job is to tell a
   * moderator reading the Dismissed tab, or three pages into a backlog, that
   * something urgent is waiting somewhere they are not looking. A per-page
   * count could only ever confirm what the page already shows.
   *
   * **`null` means "not recounted here", never "none".** The number belongs to
   * the queue rather than to the page, so re-running the `COUNT` on every
   * "Load more" would buy nothing; the repository is asked only when the
   * cursor is absent. A client holding pages keeps the first page's value,
   * which is what `queueViewState` does. Zero is a real answer and says
   * nothing urgent is open.
   */
  openUrgentCount: number | null;
};

/**
 * What a review tells the moderator: the report's new status, whether the
 * target ended up hidden by it, and whether it was brought back.
 *
 * **`targetRestored` reports what the restore did, not what was allowed**, as
 * `targetHidden` does for the hide. It is `false` on every `HIDE`, and on a
 * `DISMISS` where the target was not hidden, was hidden by a moderator, or is
 * gone.
 */
export type ReviewResult = {
  reportId: string;
  status: ReportStatus;
  targetHidden: boolean;
  targetRestored: boolean;
};

/**
 * The handle shown when the reported user has no profile row. Unreachable
 * while a report requires a content author who is a member, but the handle
 * lookup is a join, and rendering `undefined` in the queue is worse than this.
 */
const UNKNOWN_REPORTED_HANDLE = "unknown";

export const toQueuedReport = (
  report: StoredReport,
  reportedHandle: string | undefined,
): QueuedReport => ({
  id: report.id,
  targetType: report.targetType,
  targetId: report.targetId,
  reason: report.reason,
  message: report.message,
  contentSnapshot: report.contentSnapshot,
  status: report.status,
  reportedHandle: reportedHandle ?? UNKNOWN_REPORTED_HANDLE,
  dateCreated: report.dateCreated,
  urgent: isUrgentReportReason(report.reason),
});

/**
 * The reported user's platform account, as a moderator is shown it.
 *
 * **The one published shape in Community that carries a real name and a real
 * email**, and the only exit from pseudonymity the module offers (spec §13.3).
 * Everything else about this boundary file exists to keep identity *out*; this
 * type is the sanctioned exception, which is why it is here rather than
 * assembled in a procedure.
 *
 * **The fields are written out rather than aliased to `PlatformIdentity`.**
 * That is the §13.1 mechanism pointed outward: the port's type belongs to the
 * host, so a member added to it — a phone number, an address — would otherwise
 * reach the wire the moment NUCarpool's adapter supplied one, without anyone
 * editing a file whose name says it is the boundary. Widening what a moderator
 * is shown has to be a decision taken here.
 *
 * **There is no reporter, in any form**, for the reason `QueuedReport` gives,
 * and one more: §13.4 forbids exposing a reporter to the reported party, and a
 * moderator who could unmask reporters is the same exposure one conversation
 * away. The service passes exactly one id to the host.
 *
 * `account` is `null` when the reported user has no platform account. That is
 * an answer, not a refusal — the moderator already knows the report exists, so
 * concealing the absence protects nobody and leaves a dead end looking like a
 * fault.
 */
export type ReportedIdentity = {
  reportId: string;
  account: {
    userId: string;
    name: string | null;
    email: string | null;
  } | null;
};
