import { requireModerator, type CommunityActor, type Member } from "../actor";
import type {
  ContentTargetHider,
  ContentTargetReader,
  TargetType,
} from "../content/public";
import type { CommunityHostPort } from "../host/CommunityHostPort";
import type { ProfileReader } from "../identity/ports";
import {
  AlreadyResolvedError,
  ContentUnavailableError,
} from "../shared/errors";
import { decodeCursor, encodeCursor } from "../shared/cursor";
import { clampPageSize } from "../shared/paging";
import { requireBoundedText } from "../shared/text";
import { shouldAutoHide } from "./domain/autoHide";
import {
  REPORT_MESSAGE_MAX_LENGTH,
  REVIEW_NOTE_MAX_LENGTH,
} from "./domain/reportLimits";
import type { ReportReason, ReportRepository, ReportStatus } from "./ports";
import {
  toQueuedReport,
  type ReportQueuePage,
  type ReportReceipt,
  type ReportedIdentity,
  type ReviewResult,
} from "./public";

/**
 * Filing a report, and the automatic hide that three of them trigger.
 *
 * **The receipt reveals nothing.** Telling a reporter "we removed that post"
 * confirms their report was acted on, and in a small pseudonymous community
 * that is enough to work out who reported whom. `create` acknowledges receipt
 * and stops: no status, no count, and no sign of whether this report was the
 * one that hid the content.
 *
 * **The snapshot is taken here, from the stored row**, never from anything the
 * caller sent. That is why a report survives the purge of what it describes:
 * the author may edit or delete the original, and the report still says what
 * the reporter saw.
 *
 * **The visibility read is a refusal, not a filter**, for the reason spec §7.2
 * gives. Without it, whether a report succeeded would tell a blocked user that
 * the post is still there, so an unreadable target is refused as
 * `ContentUnavailableError` like every other way of not being able to see it.
 *
 * **That read is not the arbiter of anything else.** Content can be hidden
 * between the read and the insert, and the report must still land with its
 * snapshot: it is the evidence, and losing it because a moderator acted a
 * moment earlier would destroy exactly the record §13.3 exists to keep. So the
 * insert does not depend on the target still being visible, and the unique
 * `(reporterId, targetType, targetId)` triple — not a prior read — decides
 * whether the report is new.
 */
export class ReportService {
  constructor(
    private readonly reports: ReportRepository,
    private readonly targets: ContentTargetReader,
    private readonly hider: ContentTargetHider,
    private readonly host: CommunityHostPort,
  ) {}

  async create(
    actor: Member,
    input: {
      targetType: TargetType;
      targetId: string;
      reason: ReportReason;
      message?: string;
    },
  ): Promise<ReportReceipt> {
    // Pure and cheap, and the refusal a composer hits most often, so it goes
    // before any I/O.
    const message = this.boundMessage(input.message);

    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(
      actor.userId,
    );
    const target = await this.targets.findVisibleTarget(
      input.targetType,
      input.targetId,
      excludeAuthorIds,
    );
    if (target === null) {
      throw new ContentUnavailableError();
    }

    const outcome = await this.reports.upsert({
      reporterId: actor.userId,
      reportedUserId: target.authorId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      message,
      contentSnapshot: target.snapshot,
      dateCreated: this.host.now(),
    });

    // Only a new report can move the count of distinct reporters. An update
    // changes the reason and the message and nothing the threshold reads, so
    // re-counting would be a query that can only return the same answer.
    if (outcome === "created") {
      const counts = await this.reports.countsFor(
        input.targetType,
        input.targetId,
      );
      if (shouldAutoHide(counts)) {
        await this.hider.hide(
          input.targetType,
          input.targetId,
          this.host.now(),
        );
      }
    }

    return { acknowledged: true };
  }

  /**
   * A report message is optional, so a blank one is no message rather than an
   * error: `requireBoundedText` refuses empty text, which is right for a post
   * title and wrong for a dialog the reporter left empty on purpose.
   */
  private boundMessage(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim().length === 0) {
      return null;
    }
    return requireBoundedText("Message", raw, REPORT_MESSAGE_MAX_LENGTH);
  }
}

/**
 * The moderator's side: reading the queue, and resolving a report once.
 *
 * **Both methods take `CommunityActor` and narrow it themselves.** The
 * procedure refuses a non-moderator too, so this is a second check rather than
 * a duplicate: the transport layer is one caller of this service, not the only
 * one it will ever have, and an authorization rule that lives in one layer is
 * a rule the next caller can route around. Defence in depth across the layer
 * boundary.
 *
 * **Moderator access is recorded, not merely allowed** (spec §13.3). Each
 * method writes its audit entry before it returns, and the trigger is access,
 * not success: a review that loses the race to another moderator is recorded
 * too, as the distinct outcome `ALREADY_RESOLVED`. The loser had read the full
 * stored report, reporter and reported ids included, before its update matched
 * nothing, which is the same access an empty queue page audits.
 *
 * Two refusals write nothing, because nothing was accessed. `requireModerator`
 * throws before any read, and an unknown report id means `findById` returned
 * `null`, so there was no report to see.
 */
export class ModerationService {
  constructor(
    private readonly reports: ReportRepository,
    private readonly hider: ContentTargetHider,
    private readonly profiles: ProfileReader,
    private readonly host: CommunityHostPort,
  ) {}

  /**
   * One page of the queue, newest first.
   *
   * **The audit is written before the page is returned, not after.** §13.3
   * requires that access be recorded rather than merely allowed, and a record
   * written on the way out is a record a thrown error skips: the handle lookup
   * or the page assembly failing would leave a moderator having seen reports
   * with nothing to show for it. It is written for an empty page too, because
   * the access happened whether or not it found anything.
   *
   * **Urgency filters this queue; it does not order it** (SCRUM-701). A
   * `SAFETY_CONCERN` report is still returned in `dateCreated` order among its
   * neighbours, so a safety report filed on Monday sits below spam filed on
   * Tuesday unless `urgentOnly` is set. Sorting urgent reports to the top
   * would mean urgency inside the index below — a schema change, a migration,
   * and a third cursor shape — so what is offered instead is a filter and
   * `openUrgentCount`, which together let a moderator find the urgent reports
   * without the queue pretending to rank them. That is a real limitation and
   * is stated here rather than hidden behind an `ORDER BY` that would scan.
   *
   * **The keyset tiebreak is `id`, which `@@index([status, dateCreated])` does
   * not carry.** The index gives the status filter and the date order; the
   * `id` comparison is then applied as a filter over the narrow range of rows
   * sharing a millisecond, not served from an index column. That is acceptable
   * because ties within one status and one millisecond are few, and widening
   * the index to `(status, dateCreated, id)` is a schema change this ticket
   * deliberately does not make. Do not tune it here.
   */
  async queue(
    actor: CommunityActor,
    input: {
      status?: ReportStatus;
      cursor?: string;
      limit?: number;
      urgentOnly?: boolean;
    } = {},
  ): Promise<ReportQueuePage> {
    const moderator = requireModerator(actor);

    const status = input.status ?? "OPEN";
    const limit = clampPageSize(input.limit);
    const urgentOnly = input.urgentOnly ?? false;
    const after = input.cursor ? decodeCursor(input.cursor, "new") : null;

    const rows = await this.reports.list({
      status,
      after,
      limit: limit + 1,
      urgentOnly,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Before the handle lookup, so that lookup failing cannot leave the read
    // above unrecorded.
    await this.host.recordModeratorAction({
      moderatorId: moderator.userId,
      action: "community.moderation.queue",
      // A page names no single report; the filter that produced it is the
      // fact worth finding by index.
      targetId: status,
      // `urgentOnly` is recorded because the audit answers what a moderator
      // looked at, and "the open queue" and "the urgent open queue" are
      // different questions with different answers. Without it the trail
      // cannot distinguish a moderator working the backlog from one going
      // straight to the safety reports.
      metadata: { reportIds: page.map((row) => row.id), urgentOnly },
    });

    const handles = await this.profiles.findManyByUserIds([
      ...new Set(page.map((row) => row.reportedUserId)),
    ]);

    // **Only on a first page.** The number describes the whole open urgent
    // queue rather than this page, so a client paging through a backlog
    // already has it and re-running the `COUNT` per "Load more" would buy the
    // same answer again. `null` says "not recounted here"; see
    // `ReportQueuePage` for why that is not the same as zero.
    //
    // After the audit, like the handle lookup, so a failing count cannot
    // leave the read above unrecorded.
    const openUrgentCount =
      after === null ? await this.reports.countOpenUrgent() : null;

    const last = page[page.length - 1];
    return {
      reports: page.map((row) =>
        toQueuedReport(row, handles.get(row.reportedUserId)?.handle),
      ),
      openUrgentCount,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sort: "new",
              dateCreated: last.dateCreated,
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Hides the reported content or dismisses the report, once.
   *
   * **The conditional update is the arbiter, not the read.** `findById` exists
   * only to refuse an unknown id; two moderators can both read the report as
   * open and both proceed. `resolve` writes only while the status is still
   * `OPEN`, so exactly one of them gets `true`, and the other's `false` becomes
   * `AlreadyResolvedError`: one resolution and one clear refusal, never two.
   *
   * **The report is resolved before the content is touched**, so only the
   * winner acts on the target. Hiding first would let the loser of a HIDE
   * versus DISMISS race hide content the winner had just cleared.
   *
   * **The cost of that order is a window with nothing transactional across
   * it.** If `resolve` succeeds and `hide` then throws, or the process dies
   * between them, the report is `REVIEWED` over content that is still visible.
   * A plain throw from `hide` opens the same window as a crash. It is
   * self-concealing: the report is no longer `OPEN`, so it drops out of the
   * default queue and nothing resurfaces it, and a moderator who retries gets
   * `AlreadyResolvedError`, which reads as "someone else handled it" while the
   * content is still up. The other order would fail safe, a hidden post with an
   * open report, but only by giving up the race guarantee above, and a report
   * left open is at least visible. There is no reconciliation path today: a
   * stuck row is found only by comparing reviewed reports against visible
   * targets.
   *
   * **An unknown id is `ContentUnavailableError`**, the same refusal as any
   * other absence, so a probe cannot enumerate report ids.
   *
   * **`HIDE` answers every open report on the target; `DISMISS` answers only
   * this one.** A queue showing the same post three times would otherwise need
   * three identical reviews. Dismissing is different: it is a judgement on one
   * person's complaint, not on a different person's complaint about the same
   * content.
   *
   * **`targetHidden` reports what the hide did**, not what was asked. Content
   * that is already hidden or gone moves no row, so the report still resolves,
   * with `false`, rather than failing a decision that is otherwise valid.
   *
   * **A `DISMISS` restores a target the threshold hid, and only that.** Without
   * it auto-hide would be a one-way door: nothing else clears `hiddenAt`, so
   * three coordinated reporters would outrank every moderator decision. The
   * restore is also what makes the `hasDismissedReport` veto in `shouldAutoHide`
   * reachable — once a dismissed report is on the target, neither the same
   * reporters nor new ones can hide it again, which is the protection the
   * veto exists to give and could not while a hide was permanent.
   *
   * **Whether a hide was automatic is inferred, not recorded**: it was if and
   * only if no report on the target is `REVIEWED`. A moderator's `HIDE` is the
   * only writer of `REVIEWED` and it resolves every sibling, whereas an
   * auto-hide resolves nothing — so a `REVIEWED` report means a person took the
   * content down, and a dismissal of some other report must not undo that.
   * `hiddenAt` cannot say who hid a row, which is why the answer comes from the
   * reports.
   *
   * **That read decides policy, not concurrency.** The `unhide` `WHERE` is
   * still what arbitrates, and `targetRestored` is what it returned. The guard
   * has no sequential job: a moderator's `HIDE` resolves every sibling and
   * `ReportService.create` refuses a hidden target, so no open report can sit
   * on a moderator-hidden target except by a race. It exists for that race and
   * is not atomic with the restore, so it is backed by a compensation.
   *
   * **The race is a lost update between two moderators, not a partial
   * failure.** A dismisses one report and reads the counts (no `REVIEWED`); B
   * hides on a different report of the same auto-hidden target, so B's
   * `resolve` commits and B's `hide` moves nothing, the row already being down;
   * A then restores. B's deliberate decision is silently reversed, and the
   * dismissed report then vetoes any later auto-hide. That is a different thing
   * from the `resolve`-then-`hide` window above, which is one actor's failure
   * that a retry sees as a `REVIEWED` report over visible content.
   *
   * **After a successful restore the counts are read once more, and a
   * `REVIEWED` report puts the hide back.** This is compensation after the
   * write, not a guard before it; the `WHERE` clauses stay the arbiter. It is
   * sound because the bad case needs B's `resolve` to have committed before A's
   * restore, so a read after the restore always sees it; and if B's `resolve`
   * lands later, B's own `hide` finds a visible row and wins, which makes A's
   * re-hide a no-op. The costs are one extra read on the rare path where a
   * restore succeeded, a moment of visibility in between, and a fresh
   * `hiddenAt` stamped by the re-hide.
   *
   * **The compensation can itself fail, and that is not silent.** The restore
   * has committed by then, so a failed re-read or re-hide leaves the target
   * visible and a moderator's decision reversed. The audit entry is written
   * anyway, with `targetRestored: true` and `compensationFailed: true`, and
   * the error is then rethrown. A retry cannot repair it — this report is
   * already `DISMISSED` — so the record, and the error the moderator sees, are
   * what remain to act on.
   */
  async review(
    actor: CommunityActor,
    input: { reportId: string; action: "HIDE" | "DISMISS"; note?: string },
  ): Promise<ReviewResult> {
    const moderator = requireModerator(actor);
    const note = this.boundNote(input.note);

    const report = await this.reports.findById(input.reportId);
    if (report === null) {
      throw new ContentUnavailableError();
    }

    const status = input.action === "HIDE" ? "REVIEWED" : "DISMISSED";
    const won = await this.reports.resolve({
      reportId: report.id,
      status,
      reviewedById: moderator.userId,
      reviewNote: note,
    });
    const selfFiled = report.reporterId === moderator.userId;
    if (!won) {
      // The report was read in full above, so this is access, and it is
      // recorded as an outcome that cannot be mistaken for a decision.
      await this.host.recordModeratorAction({
        moderatorId: moderator.userId,
        action: "community.moderation.review",
        targetId: report.id,
        metadata: {
          attempted: input.action,
          outcome: "ALREADY_RESOLVED",
          selfFiled,
        },
      });
      throw new AlreadyResolvedError();
    }

    let targetHidden = false;
    let targetRestored = false;
    let siblingsResolved = 0;
    // Set when the compensation below threw, so the record can say so and the
    // error can still reach the caller once it is written.
    let compensationFailed = false;
    let compensationError: unknown;
    if (input.action === "HIDE") {
      targetHidden = await this.hider.hide(
        report.targetType,
        report.targetId,
        this.host.now(),
      );
      siblingsResolved = await this.reports.resolveSiblings({
        targetType: report.targetType,
        targetId: report.targetId,
        exceptReportId: report.id,
        status,
        reviewedById: moderator.userId,
      });
    } else {
      // The read comes after this moderator's own `resolve`, which is what
      // closes the race with another moderator acting on this same report:
      // only the winner of that `resolve` gets here, and it is not racing
      // itself. A different report's `REVIEWED` can still land after the read,
      // which is what the re-read below covers.
      const counts = await this.reports.countsFor(
        report.targetType,
        report.targetId,
      );
      if (!counts.hasReviewedReport) {
        targetRestored = await this.hider.restore(
          report.targetType,
          report.targetId,
        );
        if (targetRestored) {
          // Compensation, not a guard: see the lost-update note above.
          //
          // **A throw here is caught, audited and then rethrown**, because the
          // restore has already committed. Letting it escape would skip the
          // audit below and leave a moderator's decision reversed with no
          // record, and a retry would get `AlreadyResolvedError` since this
          // report is already `DISMISSED` — the same hole `queue` closes by
          // writing its audit before it returns. The content *is* visible, so
          // the record says `targetRestored: true`, and `compensationFailed`
          // is what tells it apart from an ordinary restore.
          try {
            const after = await this.reports.countsFor(
              report.targetType,
              report.targetId,
            );
            if (after.hasReviewedReport) {
              await this.hider.hide(
                report.targetType,
                report.targetId,
                this.host.now(),
              );
              targetRestored = false;
            }
          } catch (error) {
            compensationFailed = true;
            compensationError = error;
          }
        }
      }
    }

    // After the outcome is known, because the record names it; before the
    // return, for the reason `queue` gives. A moderator reviewing a report
    // they filed themselves is allowed, and is visible here.
    await this.host.recordModeratorAction({
      moderatorId: moderator.userId,
      action: "community.moderation.review",
      targetId: report.id,
      metadata: {
        decision: input.action,
        outcome: status,
        targetHidden,
        targetRestored,
        compensationFailed,
        siblingsResolved,
        selfFiled,
      },
    });

    // After the audit, so the moderator is told the review did not complete
    // cleanly rather than seeing a success that left their decision undone.
    if (compensationFailed) {
      throw compensationError;
    }

    return { reportId: report.id, status, targetHidden, targetRestored };
  }

  /**
   * Who the reported user is, on the platform.
   *
   * **The one place Community's pseudonymity is deliberately exited** (spec
   * §13.3), and every constraint below exists to keep that exit narrow.
   *
   * **The input names a report, not a user.** `QueuedReport` carries no
   * `reportedUserId` by construction, so a client has no user id to send and
   * must not be handed a way to get one; the id comes off the stored row here.
   * That also means an unmasking cannot be requested in the abstract — there
   * is always a filed report behind it, which is what makes the audit trail
   * answer "why" and not merely "who". A handle-to-person lookup taking a
   * handle would have none of that.
   *
   * **Exactly one id reaches the host.** The stored report carries
   * `reporterId` too, and §13.4 forbids exposing a reporter to anyone at all.
   * Passing the report's ids as a pair would unmask both ends of a complaint
   * in one call, which is the single worst thing this module could do.
   *
   * **Two entries are written, and the service's goes first.** The port audits
   * the disclosure itself — that is its contract, and `FakeCommunityHost` and
   * `StandaloneHostAdapter` both honour it — but the port takes ids and
   * nothing else, so the row it writes cannot say which report warranted the
   * call. This writes that justification, keyed on the report, *before*
   * reaching the host, mirroring `StandaloneHostAdapter`'s own audit-first
   * order and for the same reason: if one of the two is going to be missing,
   * it must be the disclosure that never happened, never the disclosure that
   * did. The cost is that a failed resolution still leaves a justification
   * row, which reads as an attempt — and an attempt is a true thing to record.
   *
   * **Any status is resolvable, deliberately.** A referral to student conduct
   * usually follows a hide rather than preceding it, so gating this on `OPEN`
   * would make the queue's Hidden tab the one place the escalation is not
   * available. The report being resolved is not evidence that nothing further
   * is owed.
   *
   * **An unknown id is `ContentUnavailableError`**, as in `review`, so a probe
   * cannot enumerate report ids by watching which refusals differ.
   *
   * **A reported user with no platform account is `account: null`.** The port
   * leaves unresolvable ids out of its map rather than failing, and the
   * moderator already knows the report exists, so there is nothing a refusal
   * would protect.
   */
  async identify(
    actor: CommunityActor,
    input: { reportId: string },
  ): Promise<ReportedIdentity> {
    const moderator = requireModerator(actor);

    const report = await this.reports.findById(input.reportId);
    if (report === null) {
      throw new ContentUnavailableError();
    }

    // Before the host, for the reason above. `metadata.contentId` is the
    // reported post or comment; the entry's own `targetId` is the report.
    await this.host.recordModeratorAction({
      moderatorId: moderator.userId,
      action: "community.moderation.identify",
      targetId: report.id,
      metadata: {
        targetType: report.targetType,
        contentId: report.targetId,
        reason: report.reason,
      },
    });

    const resolved = await this.host.resolvePlatformIdentities(
      moderator.userId,
      [report.reportedUserId],
    );
    const identity = resolved.get(report.reportedUserId);

    return {
      reportId: report.id,
      // Field by field, never a spread of the port's type: see
      // `ReportedIdentity` for why this stays tedious on purpose.
      account: identity
        ? {
            userId: identity.userId,
            name: identity.name,
            email: identity.email,
          }
        : null,
    };
  }

  /** A note is optional, so a blank one is no note, as with a report message. */
  private boundNote(raw: string | undefined): string | null {
    if (raw === undefined || raw.trim().length === 0) {
      return null;
    }
    return requireBoundedText("Note", raw, REVIEW_NOTE_MAX_LENGTH);
  }
}
