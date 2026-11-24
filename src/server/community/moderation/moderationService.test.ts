import type { CommunityActor, Member, Moderator } from "../actor";
import { ContentTargets } from "../content/targets";
import { FakeCommunityHost } from "../host/fakeHost";
import { asProfileReader } from "../identity/service";
import {
  AlreadyResolvedError,
  ContentUnavailableError,
  NotModeratorError,
  TextTooLongError,
} from "../shared/errors";
import { FakeCommentRepository } from "../testing/fakeCommentRepository";
import { FakePostRepository } from "../testing/fakeContentRepositories";
import { FakeProfileRepository } from "../testing/fakeProfileRepository";
import { FakeReportRepository } from "../testing/fakeReportRepository";
import { REVIEW_NOTE_MAX_LENGTH } from "./domain/reportLimits";
import type { QueuedReport, ReportReason } from "./public";
import { ModerationService, ReportService } from "./service";

const member = (n: number): Member => ({
  kind: "member",
  userId: `user-${n}`,
  profile: { id: `p${n}`, handle: `Member${n}` },
});

const moderator = (n: number): Moderator => ({
  kind: "moderator",
  userId: `mod-${n}`,
  profile: { id: `pm${n}`, handle: `Mod${n}` },
});

const AUTHOR = member(1);
const REPORTER = member(2);
const R2 = member(3);
const R3 = member(4);
const MEMBER = member(5);
const STUDENT: CommunityActor = { kind: "student", userId: "user-student" };
const MODERATOR = moderator(1);
const OTHER_MODERATOR = moderator(2);

const AT = (iso: string) => new Date(iso);

const build = async () => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const contentTargets = new ContentTargets(posts, comments);
  const reports = new FakeReportRepository();
  const profileRepo = new FakeProfileRepository();
  const host = new FakeCommunityHost();

  await profileRepo.insert({
    userId: AUTHOR.userId,
    handle: "GarageGuru",
    handleNormalized: "garageguru",
    dateCreated: AT("2026-01-01T00:00:00.000Z"),
  });

  const post = await posts.insert({
    authorId: AUTHOR.userId,
    categoryId: "cat-parking",
    title: "Parking deck rates",
    content: "Anyone know what the deck costs now?",
    dateCreated: AT("2026-02-01T00:00:00.000Z"),
  });

  const reportService = new ReportService(
    reports,
    contentTargets,
    contentTargets,
    host,
  );
  const service = new ModerationService(
    reports,
    contentTargets,
    asProfileReader(profileRepo),
    host,
  );

  await reportService.create(REPORTER, {
    targetType: "POST",
    targetId: post.id,
    reason: "SPAM",
  });

  /**
   * Files a report straight into the repository, bypassing `ReportService`.
   * Used where a test needs reports the auto-hide threshold would otherwise
   * act on, or needs to choose `dateCreated` or the reason.
   */
  const file = (
    reporterId: string,
    dateCreated: Date,
    targetId: string = post.id,
    reason: ReportReason = "SPAM",
  ) =>
    reports.upsert({
      reporterId,
      reportedUserId: AUTHOR.userId,
      targetType: "POST",
      targetId,
      reason,
      message: null,
      contentSnapshot: "snapshot",
      dateCreated,
    });

  return {
    posts,
    comments,
    reports,
    host,
    service,
    reportService,
    file,
    post,
    postId: post.id,
    reportId: reports.rows[0]!.id,
  };
};

describe("ModerationService.queue", () => {
  it("refuses a member and a student", async () => {
    const { service } = await build();

    await expect(service.queue(MEMBER)).rejects.toBeInstanceOf(
      NotModeratorError,
    );
    await expect(service.queue(STUDENT)).rejects.toBeInstanceOf(
      NotModeratorError,
    );
  });

  it("returns open reports newest first, with the reported handle and no identity", async () => {
    const { service, file } = await build();
    // Later than the report `build` filed, which carries the host clock.
    await file(R2.userId, AT("2026-10-20T00:00:00.000Z"));

    const page = await service.queue(MODERATOR);

    expect(page.reports[0]).toMatchObject({
      reportedHandle: "GarageGuru",
      status: "OPEN",
    });
    expect(page.reports).toHaveLength(2);
    expect(page.reports[0]!.dateCreated).toEqual(
      AT("2026-10-20T00:00:00.000Z"),
    );
    expect(page.reports[0]!.dateCreated.getTime()).toBeGreaterThan(
      page.reports[1]!.dateCreated.getTime(),
    );
    expect(Object.keys(page.reports[0]!)).not.toContain("reporterId");
    expect(Object.keys(page.reports[0]!)).not.toContain("reportedUserId");
    expect(Object.keys(page.reports[0]!)).not.toContain("authorId");
  });

  it("serves the snapshot taken at filing, not the live content", async () => {
    const { service, posts, postId } = await build();

    const row = posts.rowFor(postId);
    row.title = "Edited after the report";
    row.content = "Nothing to see here.";

    const page = await service.queue(MODERATOR);

    expect(page.reports[0]!.contentSnapshot).toContain("Parking deck rates");
    expect(page.reports[0]!.contentSnapshot).not.toContain("Edited");
  });

  it("filters by status", async () => {
    const { service, reports, reportId } = await build();
    await reports.resolve({
      reportId,
      status: "DISMISSED",
      reviewedById: MODERATOR.userId,
      reviewNote: null,
    });

    expect((await service.queue(MODERATOR)).reports).toHaveLength(0);
    expect(
      (await service.queue(MODERATOR, { status: "DISMISSED" })).reports,
    ).toHaveLength(1);
  });

  it("pages by cursor without dropping or repeating a report, ties included", async () => {
    const { service, file, reports } = await build();

    // Seven reports in all: the one `build` filed, four sharing a single
    // millisecond, and two later ones. The shared millisecond is the case
    // `@@index([status, dateCreated])` cannot order by itself; only the `id`
    // tiebreak keeps a page boundary inside it from dropping or repeating a
    // row.
    const SAME_MS = AT("2026-10-05T12:00:00.000Z");
    for (const n of [10, 11, 12, 13]) {
      await file(`user-${n}`, SAME_MS);
    }
    await file("user-14", AT("2026-10-06T00:00:00.000Z"));
    await file("user-15", AT("2026-10-07T00:00:00.000Z"));
    expect(
      reports.rows.filter(
        (row) => row.dateCreated.getTime() === SAME_MS.getTime(),
      ),
    ).toHaveLength(4);

    const seen: QueuedReport[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.queue(MODERATOR, { limit: 3, cursor });
      seen.push(...page.reports);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((r) => r.id)).size).toBe(7);
    // A stable descending order: by date, then by id, both descending.
    const expected = [...reports.rows].sort(
      (a, b) =>
        b.dateCreated.getTime() - a.dateCreated.getTime() ||
        b.id.localeCompare(a.id),
    );
    expect(seen.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });

  it("ends the last page with no cursor", async () => {
    const { service } = await build();

    const page = await service.queue(MODERATOR, { limit: 5 });

    expect(page.reports).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it("marks a safety report urgent and leaves the others routine", async () => {
    const { service, file } = await build();
    await file(
      R2.userId,
      AT("2026-10-20T00:00:00.000Z"),
      undefined,
      "SAFETY_CONCERN",
    );

    const page = await service.queue(MODERATOR);

    expect(page.reports[0]).toMatchObject({
      reason: "SAFETY_CONCERN",
      urgent: true,
    });
    expect(page.reports[1]).toMatchObject({ reason: "SPAM", urgent: false });
  });

  it("narrows the queue to urgent reports when asked", async () => {
    const { service, file } = await build();
    await file(
      R2.userId,
      AT("2026-10-20T00:00:00.000Z"),
      undefined,
      "SAFETY_CONCERN",
    );
    await file(
      R3.userId,
      AT("2026-10-21T00:00:00.000Z"),
      undefined,
      "OFF_TOPIC",
    );

    const all = await service.queue(MODERATOR);
    const urgent = await service.queue(MODERATOR, { urgentOnly: true });

    expect(all.reports).toHaveLength(3);
    expect(urgent.reports).toHaveLength(1);
    expect(urgent.reports[0]!.reason).toBe("SAFETY_CONCERN");
  });

  /**
   * The two filters are orthogonal on purpose: urgency says what kind of
   * report it is and status says what has been done about it, so a resolved
   * safety report has to stay findable under the Hidden tab.
   */
  it("composes the urgent filter with the status filter", async () => {
    const { service, file, reports } = await build();
    await file(
      R2.userId,
      AT("2026-10-20T00:00:00.000Z"),
      undefined,
      "SAFETY_CONCERN",
    );
    const safetyId = reports.rows.find(
      (row) => row.reason === "SAFETY_CONCERN",
    )!.id;
    await reports.resolve({
      reportId: safetyId,
      status: "REVIEWED",
      reviewedById: MODERATOR.userId,
      reviewNote: null,
    });

    const open = await service.queue(MODERATOR, { urgentOnly: true });
    const reviewed = await service.queue(MODERATOR, {
      status: "REVIEWED",
      urgentOnly: true,
    });

    expect(open.reports).toHaveLength(0);
    expect(reviewed.reports).toHaveLength(1);
    expect(reviewed.reports[0]!.id).toBe(safetyId);
  });

  it("counts the open urgent reports on a first page, whatever the page is showing", async () => {
    const { service, file } = await build();
    await file(
      R2.userId,
      AT("2026-10-20T00:00:00.000Z"),
      undefined,
      "SAFETY_CONCERN",
    );
    await file(
      R3.userId,
      AT("2026-10-21T00:00:00.000Z"),
      undefined,
      "SAFETY_CONCERN",
    );

    // The count is of the whole open urgent queue, not of this page, so a
    // moderator reading the Dismissed tab still learns that two are waiting.
    expect((await service.queue(MODERATOR)).openUrgentCount).toBe(2);
    expect(
      (await service.queue(MODERATOR, { status: "DISMISSED" })).openUrgentCount,
    ).toBe(2);
  });

  it("is zero rather than null when nothing urgent is open", async () => {
    const { service } = await build();

    expect((await service.queue(MODERATOR)).openUrgentCount).toBe(0);
  });

  /**
   * A number that belongs to the whole queue, re-fetched once per "Load
   * more", is a `COUNT` bought for an answer the first page already gave.
   */
  it("does not recount on a cursored page", async () => {
    const { service, file } = await build();
    await file(
      R2.userId,
      AT("2026-10-20T00:00:00.000Z"),
      undefined,
      "SAFETY_CONCERN",
    );

    const first = await service.queue(MODERATOR, { limit: 1 });
    const second = await service.queue(MODERATOR, {
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect(first.openUrgentCount).toBe(1);
    expect(second.openUrgentCount).toBeNull();
  });

  it("pages a filtered queue by cursor without dropping a report", async () => {
    const { service, file } = await build();
    for (const n of [20, 21, 22]) {
      await file(
        `user-${n}`,
        AT(`2026-10-${n}T00:00:00.000Z`),
        undefined,
        "SAFETY_CONCERN",
      );
    }

    const seen: QueuedReport[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.queue(MODERATOR, {
        urgentOnly: true,
        limit: 2,
        cursor,
      });
      seen.push(...page.reports);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(2);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((r) => r.id)).size).toBe(3);
    expect(seen.every((r) => r.urgent)).toBe(true);
  });

  it("writes an audit record naming the moderator and the reports shown", async () => {
    const { service, host, reportId } = await build();

    await service.queue(MODERATOR);

    expect(host.auditEntries).toHaveLength(1);
    expect(host.auditEntries[0]).toMatchObject({
      moderatorId: MODERATOR.userId,
      action: "community.moderation.queue",
      targetId: "OPEN",
    });
    expect(host.auditEntries[0]!.metadata).toMatchObject({
      reportIds: [reportId],
    });
  });

  it("audits only the reports on the page it returned, not the one it peeked at", async () => {
    const { service, host, file } = await build();
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"));

    const page = await service.queue(MODERATOR, { limit: 1 });

    expect(page.reports).toHaveLength(1);
    // Exact, not `toMatchObject`: this is the assertion that notices a field
    // being added to what a moderator's access writes down.
    expect(host.auditEntries[0]!.metadata).toEqual({
      reportIds: [page.reports[0]!.id],
      urgentOnly: false,
    });
  });

  it("records the urgent filter in the audit entry", async () => {
    const { service, host } = await build();

    await service.queue(MODERATOR, { urgentOnly: true });

    expect(host.auditEntries[0]!.metadata).toMatchObject({ urgentOnly: true });
  });

  it("has already written the audit when the handle lookup throws", async () => {
    const { reports, host } = await build();
    const failing = new ModerationService(
      reports,
      new ContentTargets(
        new FakePostRepository(),
        new FakeCommentRepository(new FakePostRepository()),
      ),
      {
        findManyByUserIds: async () => {
          throw new Error("profile store down");
        },
        findByHandleNormalized: async () => null,
      },
      host,
    );

    await expect(failing.queue(MODERATOR)).rejects.toThrow(
      "profile store down",
    );

    expect(host.auditEntries).toHaveLength(1);
    expect(host.auditEntries[0]).toMatchObject({
      action: "community.moderation.queue",
    });
  });

  it("audits an empty page too", async () => {
    const { service, host } = await build();

    const page = await service.queue(MODERATOR, { status: "DISMISSED" });

    expect(page.reports).toHaveLength(0);
    expect(host.auditEntries).toHaveLength(1);
    expect(host.auditEntries[0]).toMatchObject({ targetId: "DISMISSED" });
  });

  it("writes no audit record when the tier check refuses", async () => {
    const { service, host } = await build();

    await expect(service.queue(MEMBER)).rejects.toThrow();
    await expect(service.queue(STUDENT)).rejects.toThrow();

    expect(host.auditEntries).toHaveLength(0);
  });

  it("shows an unknown handle rather than failing when the reported user has no profile", async () => {
    const { service, reports } = await build();
    await reports.upsert({
      reporterId: R2.userId,
      reportedUserId: "user-without-profile",
      targetType: "POST",
      targetId: "post-elsewhere",
      reason: "SPAM",
      message: null,
      contentSnapshot: null,
      dateCreated: AT("2026-10-20T00:00:00.000Z"),
    });

    const page = await service.queue(MODERATOR);

    expect(page.reports.map((r) => r.reportedHandle)).toEqual([
      "unknown",
      "GarageGuru",
    ]);
  });
});

describe("ModerationService.review", () => {
  it("refuses a member and a student, and audits neither", async () => {
    const { service, host, reportId } = await build();

    await expect(
      service.review(MEMBER, { reportId, action: "HIDE" }),
    ).rejects.toBeInstanceOf(NotModeratorError);
    await expect(
      service.review(STUDENT, { reportId, action: "HIDE" }),
    ).rejects.toBeInstanceOf(NotModeratorError);

    expect(host.auditEntries).toHaveLength(0);
  });

  it("hides the target and marks the report reviewed", async () => {
    const { service, posts, reports, postId, reportId } = await build();

    const result = await service.review(MODERATOR, {
      reportId,
      action: "HIDE",
    });

    expect(result).toEqual({
      reportId,
      status: "REVIEWED",
      targetHidden: true,
      targetRestored: false,
    });
    expect(await posts.findVisibleById(postId, [])).toBeNull();
    // Hide, never delete: the row is still there.
    expect(posts.rowFor(postId).hiddenAt).not.toBeNull();
    expect(reports.rows[0]).toMatchObject({
      status: "REVIEWED",
      reviewedById: MODERATOR.userId,
    });
  });

  it("stamps the hide with the host's clock", async () => {
    const { service, posts, postId, reportId } = await build();

    await service.review(MODERATOR, { reportId, action: "HIDE" });

    expect(posts.rowFor(postId).hiddenAt).toEqual(
      AT("2026-10-09T12:00:00.000Z"),
    );
  });

  it("dismisses without touching the content", async () => {
    const { service, posts, reports, postId, reportId } = await build();

    const result = await service.review(MODERATOR, {
      reportId,
      action: "DISMISS",
      note: "normal disagreement",
    });

    expect(result).toEqual({
      reportId,
      status: "DISMISSED",
      targetHidden: false,
      targetRestored: false,
    });
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
    expect(reports.rows[0]).toMatchObject({
      status: "DISMISSED",
      reviewNote: "normal disagreement",
    });
  });

  it("trims the note, and stores a blank one as none", async () => {
    const { service, reports, file } = await build();
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"));
    const [first, second] = reports.rows;

    await service.review(MODERATOR, {
      reportId: first!.id,
      action: "DISMISS",
      note: "  padded  ",
    });
    await service.review(MODERATOR, {
      reportId: second!.id,
      action: "DISMISS",
      note: "   ",
    });

    expect(first!.reviewNote).toBe("padded");
    expect(second!.reviewNote).toBeNull();
  });

  it("refuses a second review of the same report", async () => {
    const { service, reportId } = await build();

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    await expect(
      service.review(MODERATOR, { reportId, action: "HIDE" }),
    ).rejects.toBeInstanceOf(AlreadyResolvedError);
  });

  it("does not hide anything when it loses to an earlier dismissal", async () => {
    const { service, posts, host, postId, reportId } = await build();
    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    await expect(
      service.review(OTHER_MODERATOR, { reportId, action: "HIDE" }),
    ).rejects.toBeInstanceOf(AlreadyResolvedError);

    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
    // The loser is on record too, as an outcome that is not a decision.
    const reviews = host.auditEntries.filter(
      (e) => e.action === "community.moderation.review",
    );
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.metadata).toMatchObject({ outcome: "DISMISSED" });
    expect(reviews[1]).toMatchObject({
      moderatorId: OTHER_MODERATOR.userId,
      targetId: reportId,
    });
    expect(reviews[1]!.metadata).toMatchObject({
      outcome: "ALREADY_RESOLVED",
      attempted: "HIDE",
    });
    expect(Object.keys(reviews[1]!.metadata!)).not.toContain("targetHidden");
  });

  // This proves the service's logic over the fake: the conditional `resolve`
  // is what the service relies on, and the fake reproduces its contract. It
  // does not prove InnoDB's row locking decides the same way under real
  // concurrent transactions; a later task records that gap.
  it("yields exactly one resolution when two moderators review concurrently", async () => {
    const { service, posts, reports, host, postId, reportId } = await build();

    const outcomes = await Promise.allSettled([
      service.review(MODERATOR, { reportId, action: "HIDE" }),
      service.review(OTHER_MODERATOR, { reportId, action: "DISMISS" }),
    ]);

    const fulfilled = outcomes.filter(
      (
        o,
      ): o is PromiseFulfilledResult<
        Awaited<ReturnType<typeof service.review>>
      > => o.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(AlreadyResolvedError);

    // What is stored is the winner's decision, and the loser changed nothing.
    const winner = fulfilled[0]!.value;
    expect(reports.rows[0]!.status).toBe(winner.status);
    expect(reports.rows[0]!.reviewedById).toBe(
      winner.status === "REVIEWED" ? MODERATOR.userId : OTHER_MODERATOR.userId,
    );
    expect(posts.rowFor(postId).hiddenAt !== null).toBe(
      winner.status === "REVIEWED",
    );
    // One decision and one refused attempt, each on record.
    const recorded = host.auditEntries
      .filter((e) => e.action === "community.moderation.review")
      .map((e) => e.metadata!.outcome)
      .sort();
    expect(recorded).toEqual([winner.status, "ALREADY_RESOLVED"].sort());
  });

  it("resolves the other open reports on the same target when it hides", async () => {
    const { service, reports, file, reportId } = await build();
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"));
    await file(R3.userId, AT("2026-10-02T00:00:00.000Z"));
    expect(reports.rows.filter((r) => r.status === "OPEN")).toHaveLength(3);

    await service.review(MODERATOR, { reportId, action: "HIDE" });

    expect(reports.rows.filter((r) => r.status === "OPEN")).toHaveLength(0);
    expect(reports.rows.map((r) => r.status)).toEqual([
      "REVIEWED",
      "REVIEWED",
      "REVIEWED",
    ]);
    expect(reports.rows.every((r) => r.reviewedById === MODERATOR.userId)).toBe(
      true,
    );
  });

  it("audits how many sibling reports a hide resolved", async () => {
    const { service, host, file, reportId } = await build();
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"));
    await file(R3.userId, AT("2026-10-02T00:00:00.000Z"));

    await service.review(MODERATOR, { reportId, action: "HIDE" });

    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      siblingsResolved: 2,
    });
  });

  it("audits no siblings resolved for a dismissal", async () => {
    const { service, host, file, reportId } = await build();
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"));

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      siblingsResolved: 0,
    });
  });

  it("hides a reported comment, and leaves its post alone", async () => {
    const { service, posts, comments, reports, postId } = await build();
    const comment = (await comments.insert({
      postId,
      authorId: AUTHOR.userId,
      content: "Rude remark.",
      dateCreated: AT("2026-02-03T00:00:00.000Z"),
    }))!;
    await reports.upsert({
      reporterId: R2.userId,
      reportedUserId: AUTHOR.userId,
      targetType: "COMMENT",
      targetId: comment.id,
      reason: "HARASSMENT",
      message: null,
      contentSnapshot: comment.content,
      dateCreated: AT("2026-10-10T00:00:00.000Z"),
    });
    const commentReport = reports.rows.find((r) => r.targetId === comment.id)!;

    const result = await service.review(MODERATOR, {
      reportId: commentReport.id,
      action: "HIDE",
    });

    expect(result).toEqual({
      reportId: commentReport.id,
      status: "REVIEWED",
      targetHidden: true,
      targetRestored: false,
    });
    expect(await comments.findVisibleById(comment.id, [])).toBeNull();
    expect(comments.rowFor(comment.id).hiddenAt).not.toBeNull();
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
  });

  it("does not resolve open reports on a different target when it hides", async () => {
    const { service, posts, reports, file, reportId } = await build();
    const other = await posts.insert({
      authorId: AUTHOR.userId,
      categoryId: "cat-parking",
      title: "Another post",
      content: "Unrelated.",
      dateCreated: AT("2026-02-02T00:00:00.000Z"),
    });
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"), other.id);

    await service.review(MODERATOR, { reportId, action: "HIDE" });

    expect(reports.rows.find((r) => r.targetId === other.id)!.status).toBe(
      "OPEN",
    );
  });

  it("leaves the other open reports alone when it dismisses", async () => {
    const { service, reports, file, reportId } = await build();
    await file(R2.userId, AT("2026-10-01T00:00:00.000Z"));
    await file(R3.userId, AT("2026-10-02T00:00:00.000Z"));

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    expect(reports.rows.filter((r) => r.status === "OPEN")).toHaveLength(2);
  });

  it("resolves with targetHidden false when auto-hide already hid the target", async () => {
    const { service, reportService, posts, reports, postId, reportId } =
      await build();
    // Two more distinct reporters make three: the threshold hides the post.
    await reportService.create(R2, {
      targetType: "POST",
      targetId: postId,
      reason: "SPAM",
    });
    await reportService.create(R3, {
      targetType: "POST",
      targetId: postId,
      reason: "SPAM",
    });
    expect(posts.rowFor(postId).hiddenAt).not.toBeNull();

    const result = await service.review(MODERATOR, {
      reportId,
      action: "HIDE",
    });

    expect(result).toEqual({
      reportId,
      status: "REVIEWED",
      targetHidden: false,
      targetRestored: false,
    });
    expect(reports.rows.filter((r) => r.status === "OPEN")).toHaveLength(0);
  });

  // Review Focus 1
  it("still resolves the report when the target is already gone", async () => {
    const { service, posts, reports, postId, reportId } = await build();
    await posts.hardDelete(postId);

    const result = await service.review(MODERATOR, {
      reportId,
      action: "HIDE",
    });

    expect(result).toEqual({
      reportId,
      status: "REVIEWED",
      targetHidden: false,
      targetRestored: false,
    });
    expect(reports.rows[0]!.status).toBe("REVIEWED");
  });

  it("lets a moderator review a report they filed themselves, and records that in the audit", async () => {
    const { service, reportService, reports, host, postId } = await build();
    await reportService.create(MODERATOR, {
      targetType: "POST",
      targetId: postId,
      reason: "SPAM",
    });
    const own = reports.rows.find((r) => r.reporterId === MODERATOR.userId)!;

    const result = await service.review(MODERATOR, {
      reportId: own.id,
      action: "HIDE",
    });

    expect(result.status).toBe("REVIEWED");
    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      selfFiled: true,
    });
  });

  it("records selfFiled false for a report someone else filed", async () => {
    const { service, host, reportId } = await build();

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      selfFiled: false,
    });
  });

  it("refuses an unknown report id as ContentUnavailableError", async () => {
    const { service, host } = await build();

    await expect(
      service.review(MODERATOR, { reportId: "report-999", action: "HIDE" }),
    ).rejects.toBeInstanceOf(ContentUnavailableError);
    expect(host.auditEntries).toHaveLength(0);
  });

  it("refuses a note longer than the column, before changing anything", async () => {
    const { service, reports, posts, postId, reportId } = await build();

    await expect(
      service.review(MODERATOR, {
        reportId,
        action: "HIDE",
        note: "x".repeat(REVIEW_NOTE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(TextTooLongError);

    expect(reports.rows[0]!.status).toBe("OPEN");
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
  });

  it("writes an audit record naming the report, the action and the outcome", async () => {
    const { service, host, reportId } = await build();

    await service.review(MODERATOR, {
      reportId,
      action: "HIDE",
      note: "doxxing",
    });

    expect(host.auditEntries.at(-1)).toMatchObject({
      moderatorId: MODERATOR.userId,
      action: "community.moderation.review",
      targetId: reportId,
    });
    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      outcome: "REVIEWED",
      targetHidden: true,
    });
  });
});

/**
 * A moderator's `DISMISS` restores a target the threshold hid.
 *
 * Auto-hide was a one-way door until this: nothing cleared `hiddenAt`, so the
 * `hasDismissedReport` veto only ever fired before a hide, and three
 * coordinated reporters outranked every decision a moderator could make. The
 * cases below pin both halves — the restore, and that what is restored stays
 * restored.
 */
describe("ModerationService.review restoring an automatically hidden target", () => {
  const fileThree = async (reportService: ReportService, postId: string) => {
    // `build` filed the first report; two more distinct reporters make three.
    for (const reporter of [R2, R3]) {
      await reportService.create(reporter, {
        targetType: "POST",
        targetId: postId,
        reason: "SPAM",
      });
    }
  };

  it("restores the target when a moderator dismisses a report on an auto-hidden one", async () => {
    const { service, reportService, posts, postId, reportId } = await build();
    await fileThree(reportService, postId);
    expect(await posts.findVisibleById(postId, [])).toBeNull();

    const result = await service.review(MODERATOR, {
      reportId,
      action: "DISMISS",
    });

    expect(result).toEqual({
      reportId,
      status: "DISMISSED",
      targetHidden: false,
      targetRestored: true,
    });
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
    expect(posts.rowFor(postId).hiddenAt).toBeNull();
  });

  it("does not restore a target a moderator hid", async () => {
    const { service, posts, file, postId, reportId } = await build();
    await service.review(MODERATOR, { reportId, action: "HIDE" });
    // **Not an ordinary state.** A HIDE resolves every sibling and
    // `ReportService.create` refuses a hidden target, so no open report can sit
    // on a moderator-hidden target except through a race. The fixture goes
    // around the service with `file` to build it; the interleaving test below
    // is what shows it arising.
    await file("user-9", AT("2026-10-09T13:00:00.000Z"));
    const lateReportId = (await service.queue(MODERATOR)).reports[0]!.id;

    const result = await service.review(OTHER_MODERATOR, {
      reportId: lateReportId,
      action: "DISMISS",
    });

    expect(result.status).toBe("DISMISSED");
    expect(result.targetRestored).toBe(false);
    expect(await posts.findVisibleById(postId, [])).toBeNull();
    expect(posts.rowFor(postId).hiddenAt).not.toBeNull();
  });

  it("does not restore a target a moderator hid after the threshold already had", async () => {
    const { service, reportService, posts, file, postId, reportId } =
      await build();
    await fileThree(reportService, postId);
    // The hide moves no row — it is already down — but the report is REVIEWED,
    // which is the human decision the restore must not undo. As above, an open
    // report arriving after it is a state only a race produces; `file` builds
    // it around the service.
    await service.review(MODERATOR, { reportId, action: "HIDE" });
    await file("user-9", AT("2026-10-09T13:00:00.000Z"));
    const lateReportId = (await service.queue(MODERATOR)).reports[0]!.id;

    const result = await service.review(OTHER_MODERATOR, {
      reportId: lateReportId,
      action: "DISMISS",
    });

    expect(result.targetRestored).toBe(false);
    expect(await posts.findVisibleById(postId, [])).toBeNull();
  });

  it("reports targetRestored false, and changes nothing, for a target that was never hidden", async () => {
    const { service, posts, postId, reportId } = await build();
    const before = posts.rowFor(postId).hiddenAt;

    const result = await service.review(MODERATOR, {
      reportId,
      action: "DISMISS",
    });

    expect(result.targetRestored).toBe(false);
    expect(before).toBeNull();
    expect(posts.rowFor(postId).hiddenAt).toBeNull();
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
  });

  // The interleaving the REVIEWED guard exists for, and the only way to reach
  // it: the guard has no sequential job, since a moderator hide leaves no open
  // report behind and the service refuses new ones on a hidden target.
  it("re-hides when a moderator's hide lands between the counts read and the restore", async () => {
    const { service, reportService, posts, reports, host, postId, reportId } =
      await build();
    await fileThree(reportService, postId);
    const [, second] = reports.rows;
    expect(posts.rowFor(postId).hiddenAt).not.toBeNull();

    // Moderator B's `resolve` for a different report commits after A's counts
    // read answered "no REVIEWED report", and before A's restore. B's own hide
    // finds the target already down and moves nothing, so only A's compensation
    // can put the decision back.
    const counted = reports.countsFor.bind(reports);
    let reads = 0;
    reports.countsFor = async (targetType, targetId) => {
      const counts = await counted(targetType, targetId);
      reads += 1;
      if (reads === 1) {
        await reports.resolve({
          reportId: second!.id,
          status: "REVIEWED",
          reviewedById: OTHER_MODERATOR.userId,
          reviewNote: null,
        });
      }
      return counts;
    };

    const result = await service.review(MODERATOR, {
      reportId,
      action: "DISMISS",
    });

    expect(reads).toBe(2);
    expect(result.targetRestored).toBe(false);
    expect(await posts.findVisibleById(postId, [])).toBeNull();
    expect(posts.rowFor(postId).hiddenAt).not.toBeNull();
    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      targetRestored: false,
    });
  });

  it("keeps a moderator's hide that lands after the restore", async () => {
    const { service, reportService, posts, reports, postId, reportId } =
      await build();
    await fileThree(reportService, postId);
    const [, second] = reports.rows;

    // The other order: B's resolve and hide land right after A's restore. B's
    // hide finds a visible row and wins, and A's re-read then re-hides a row
    // that is already down, which must move nothing.
    const restore = posts.unhide.bind(posts);
    posts.unhide = async (id) => {
      const moved = await restore(id);
      await reports.resolve({
        reportId: second!.id,
        status: "REVIEWED",
        reviewedById: OTHER_MODERATOR.userId,
        reviewNote: null,
      });
      await posts.hide(id, AT("2026-10-09T12:30:00.000Z"));
      return moved;
    };

    const result = await service.review(MODERATOR, {
      reportId,
      action: "DISMISS",
    });

    // The re-read sees REVIEWED and re-hides, which finds B's hide in place
    // and moves nothing: the target is down either way, B's decision stands.
    // This pins the idempotent no-op and the reported outcome; it is the
    // interleaving test above that proves the compensation is needed.
    expect(result.targetRestored).toBe(false);
    expect(await posts.findVisibleById(postId, [])).toBeNull();
    expect(posts.rowFor(postId).hiddenAt).toEqual(
      AT("2026-10-09T12:30:00.000Z"),
    );
  });

  // The compensation is a write after a committed restore, so it can fail with
  // nothing left to undo it: the moderator's decision is reversed, and the
  // only thing that can still be made true is the record of it.
  it("audits the reversal, and rethrows, when the compensating hide fails", async () => {
    const { service, reportService, posts, reports, host, postId, reportId } =
      await build();
    await fileThree(reportService, postId);
    const [, second] = reports.rows;

    const counted = reports.countsFor.bind(reports);
    let reads = 0;
    reports.countsFor = async (targetType, targetId) => {
      const counts = await counted(targetType, targetId);
      reads += 1;
      if (reads === 1) {
        await reports.resolve({
          reportId: second!.id,
          status: "REVIEWED",
          reviewedById: OTHER_MODERATOR.userId,
          reviewNote: null,
        });
      }
      return counts;
    };
    posts.hide = async () => {
      throw new Error("database unavailable");
    };

    await expect(
      service.review(MODERATOR, { reportId, action: "DISMISS" }),
    ).rejects.toThrow("database unavailable");

    // The content is visible: the restore committed and the re-hide did not.
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
    // And the reversal is on the record, marked so an auditor can tell it from
    // an ordinary restore.
    expect(host.auditEntries.at(-1)).toMatchObject({
      moderatorId: MODERATOR.userId,
      action: "community.moderation.review",
      targetId: reportId,
    });
    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      decision: "DISMISS",
      outcome: "DISMISSED",
      targetRestored: true,
      compensationFailed: true,
    });
  });

  it("audits compensationFailed false on an ordinary review", async () => {
    const { service, host, reportId } = await build();

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      compensationFailed: false,
    });
  });

  // The test that makes the change worth having: without the restore the veto
  // is only ever consulted before a hide, and with it the veto holds.
  it("cannot be re-hidden by further reports once restored", async () => {
    const { service, reportService, posts, reports, postId, reportId } =
      await build();
    await fileThree(reportService, postId);
    await service.review(MODERATOR, { reportId, action: "DISMISS" });
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
    // Two open reports from the auto-hide survive the dismissal, so one more
    // distinct reporter would make three: only the veto stands in the way.
    expect(reports.rows.filter((r) => r.status === "OPEN")).toHaveLength(2);

    for (const n of [6, 7, 8]) {
      await reportService.create(member(n), {
        targetType: "POST",
        targetId: postId,
        reason: "HARASSMENT",
      });
    }

    expect(
      reports.rows.filter((r) => r.status === "OPEN").length,
    ).toBeGreaterThanOrEqual(3);
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
    expect(posts.rowFor(postId).hiddenAt).toBeNull();
  });

  it("reports targetRestored false on every HIDE, auto-hidden target or not", async () => {
    const plain = await build();
    expect(
      (
        await plain.service.review(MODERATOR, {
          reportId: plain.reportId,
          action: "HIDE",
        })
      ).targetRestored,
    ).toBe(false);

    const automatic = await build();
    await fileThree(automatic.reportService, automatic.postId);
    expect(
      (
        await automatic.service.review(MODERATOR, {
          reportId: automatic.reportId,
          action: "HIDE",
        })
      ).targetRestored,
    ).toBe(false);
    expect(
      await automatic.posts.findVisibleById(automatic.postId, []),
    ).toBeNull();
  });

  it("audits the restore as a moderator action", async () => {
    const { service, reportService, host, postId, reportId } = await build();
    await fileThree(reportService, postId);

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    expect(host.auditEntries.at(-1)).toMatchObject({
      moderatorId: MODERATOR.userId,
      action: "community.moderation.review",
      targetId: reportId,
    });
    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      decision: "DISMISS",
      outcome: "DISMISSED",
      targetHidden: false,
      targetRestored: true,
    });
  });

  it("audits targetRestored false for a plain dismissal and for a hide", async () => {
    const { service, host, reportId } = await build();

    await service.review(MODERATOR, { reportId, action: "DISMISS" });

    expect(host.auditEntries.at(-1)!.metadata).toMatchObject({
      targetRestored: false,
    });

    const hidden = await build();
    await hidden.service.review(MODERATOR, {
      reportId: hidden.reportId,
      action: "HIDE",
    });
    expect(hidden.host.auditEntries.at(-1)!.metadata).toMatchObject({
      targetHidden: true,
      targetRestored: false,
    });
  });
});

/**
 * A host that refuses to resolve, without auditing first.
 *
 * **It overrides rather than wraps**, so `resolvePlatformIdentities` writes
 * nothing of its own. That is what lets the order test below mean something:
 * any entry left on the fake after this rejects was written by the service,
 * not by the port.
 */
class RefusingHost extends FakeCommunityHost {
  override async resolvePlatformIdentities(): Promise<
    ReadonlyMap<string, never>
  > {
    throw new Error("platform unreachable");
  }
}

describe("ModerationService.identify", () => {
  it("refuses a member and a student", async () => {
    const { service, reportId } = await build();

    await expect(service.identify(MEMBER, { reportId })).rejects.toBeInstanceOf(
      NotModeratorError,
    );
    await expect(
      service.identify(STUDENT, { reportId }),
    ).rejects.toBeInstanceOf(NotModeratorError);
  });

  it("resolves the reported user's platform account", async () => {
    const { service, host, reportId } = await build();
    host.withIdentity(AUTHOR.userId, {
      name: "Alex Author",
      email: "author@northeastern.edu",
    });

    const result = await service.identify(MODERATOR, { reportId });

    expect(result).toEqual({
      reportId,
      account: {
        userId: AUTHOR.userId,
        name: "Alex Author",
        email: "author@northeastern.edu",
      },
    });
  });

  it("asks the host for the reported user and nobody else", async () => {
    const { service, host, reportId } = await build();
    host.withIdentity(AUTHOR.userId).withIdentity(REPORTER.userId);

    await service.identify(MODERATOR, { reportId });

    // The disclosure entry the port writes carries exactly what was asked for.
    const disclosure = host.auditEntries.find(
      (entry) =>
        entry.action === "community.moderation.identify" &&
        entry.targetId === MODERATOR.userId,
    );
    expect(disclosure?.metadata).toEqual({ userIds: [AUTHOR.userId] });
  });

  it("answers with no account when the reported user has no platform row", async () => {
    const { service, reportId } = await build();

    const result = await service.identify(MODERATOR, { reportId });

    expect(result).toEqual({ reportId, account: null });
  });

  it("refuses an unknown report id the way review does", async () => {
    const { service } = await build();

    await expect(
      service.identify(MODERATOR, { reportId: "no-such-report" }),
    ).rejects.toBeInstanceOf(ContentUnavailableError);
  });

  it("records the report that justified the unmasking", async () => {
    const { service, host, reports, reportId } = await build();
    host.withIdentity(AUTHOR.userId);

    await service.identify(MODERATOR, { reportId });

    const justification = host.auditEntries.find(
      (entry) => entry.targetId === reportId,
    );
    expect(justification).toMatchObject({
      moderatorId: MODERATOR.userId,
      action: "community.moderation.identify",
      metadata: {
        targetType: "POST",
        contentId: reports.rows[0]!.targetId,
        reason: "SPAM",
      },
    });
  });

  it("writes the justification before the host is reached", async () => {
    const host = new RefusingHost();
    const posts = new FakePostRepository();
    const comments = new FakeCommentRepository(posts);
    const contentTargets = new ContentTargets(posts, comments);
    const reports = new FakeReportRepository();
    const profileRepo = new FakeProfileRepository();
    const post = await posts.insert({
      authorId: AUTHOR.userId,
      categoryId: "cat-parking",
      title: "Parking deck rates",
      content: "Anyone know what the deck costs now?",
      dateCreated: AT("2026-02-01T00:00:00.000Z"),
    });
    await reports.upsert({
      reporterId: REPORTER.userId,
      reportedUserId: AUTHOR.userId,
      targetType: "POST",
      targetId: post.id,
      reason: "SPAM",
      message: null,
      contentSnapshot: "snapshot",
      dateCreated: AT("2026-10-09T12:00:00.000Z"),
    });
    const service = new ModerationService(
      reports,
      contentTargets,
      asProfileReader(profileRepo),
      host,
    );
    const reportId = reports.rows[0]!.id;

    await expect(service.identify(MODERATOR, { reportId })).rejects.toThrow(
      "platform unreachable",
    );

    // The disclosure never happened, and the attempt is still on the record.
    expect(host.auditEntries).toHaveLength(1);
    expect(host.auditEntries[0]).toMatchObject({
      action: "community.moderation.identify",
      targetId: reportId,
    });
  });
});
