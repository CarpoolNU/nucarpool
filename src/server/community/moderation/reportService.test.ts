import type { Member } from "../actor";
import { ContentTargets } from "../content/targets";
import type {
  ContentTarget,
  ContentTargetReader,
  TargetType,
} from "../content/public";
import { FakeCommunityHost } from "../host/fakeHost";
import { ContentUnavailableError, TextTooLongError } from "../shared/errors";
import { FakeCommentRepository } from "../testing/fakeCommentRepository";
import { FakePostRepository } from "../testing/fakeContentRepositories";
import { FakeReportRepository } from "../testing/fakeReportRepository";
import type { ReportRepository, StoredReport } from "./ports";
import { REPORT_MESSAGE_MAX_LENGTH } from "./domain/reportLimits";
import { ReportService } from "./service";

const member = (n: number): Member => ({
  kind: "member",
  userId: `user-${n}`,
  profile: { id: `p${n}`, handle: `Member${n}` },
});

const AUTHOR = member(1);
const REPORTER = member(2);
const R1 = member(3);
const R2 = member(4);
const R3 = member(5);
const R4 = member(6);

const AT = (iso: string) => new Date(iso);

/**
 * A moment no clock in these tests produces, so a `hiddenAt` carrying it can
 * only have come from the race hook and not from the service. It differs from
 * `FakeCommunityHost`'s default clock on purpose.
 */
const RACE_HIDDEN_AT = AT("2031-01-01T00:00:00.000Z");

/**
 * A `ReportRepository` that delegates to the fake and counts how often the
 * service asked for the reporter counts.
 *
 * The count is the wrapper's own field, read as state; the point is to see
 * whether the service re-evaluated the threshold, not to inspect a call log.
 */
class CountingReportRepository implements ReportRepository {
  countsForCalls = 0;

  constructor(private readonly inner: FakeReportRepository) {}

  get rows(): StoredReport[] {
    return this.inner.rows;
  }

  upsert: ReportRepository["upsert"] = (input) => this.inner.upsert(input);

  countsFor: ReportRepository["countsFor"] = (targetType, targetId) => {
    this.countsForCalls += 1;
    return this.inner.countsFor(targetType, targetId);
  };

  findById: ReportRepository["findById"] = (id) => this.inner.findById(id);
  list: ReportRepository["list"] = (query) => this.inner.list(query);
  countOpenUrgent: ReportRepository["countOpenUrgent"] = () =>
    this.inner.countOpenUrgent();
  resolve: ReportRepository["resolve"] = (input) => this.inner.resolve(input);
  resolveSiblings: ReportRepository["resolveSiblings"] = (input) =>
    this.inner.resolveSiblings(input);
}

/**
 * A reader that can lose the race a real one loses to a moderator.
 *
 * `hideAfterNextRead` arms a one-shot: the next visibility read returns the
 * target as visible, and the row is hidden immediately afterwards — exactly the
 * interleaving "the moderator acted a millisecond after we looked", produced
 * deterministically rather than by timing.
 */
class RacingTargetReader implements ContentTargetReader {
  private armed = false;

  constructor(private readonly inner: ContentTargets) {}

  hideAfterNextRead(): void {
    this.armed = true;
  }

  async findVisibleTarget(
    type: TargetType,
    id: string,
    excludeAuthorIds: readonly string[],
  ): Promise<ContentTarget | null> {
    const target = await this.inner.findVisibleTarget(
      type,
      id,
      excludeAuthorIds,
    );
    if (this.armed) {
      this.armed = false;
      await this.inner.hide(type, id, RACE_HIDDEN_AT);
    }
    return target;
  }
}

const build = async () => {
  const posts = new FakePostRepository();
  const comments = new FakeCommentRepository(posts);
  const contentTargets = new ContentTargets(posts, comments);
  const targets = new RacingTargetReader(contentTargets);
  const reports = new CountingReportRepository(new FakeReportRepository());
  const host = new FakeCommunityHost();

  const post = await posts.insert({
    authorId: AUTHOR.userId,
    categoryId: "cat-parking",
    title: "Parking deck rates",
    content: "Anyone know what the deck costs now?",
    dateCreated: AT("2026-02-01T00:00:00.000Z"),
  });

  return {
    posts,
    comments,
    reports,
    host,
    targets,
    post,
    postId: post.id,
    service: new ReportService(reports, targets, contentTargets, host),
  };
};

describe("ReportService.create", () => {
  it("acknowledges a report and tells the reporter nothing else", async () => {
    const { service, postId } = await build();

    expect(
      await service.create(REPORTER, {
        targetType: "POST",
        targetId: postId,
        reason: "SPAM",
      }),
    ).toStrictEqual({ acknowledged: true });
  });

  it("stores the reported author and a server-built snapshot of the content", async () => {
    const { service, reports, postId } = await build();

    await service.create(REPORTER, {
      targetType: "POST",
      targetId: postId,
      reason: "HARASSMENT",
    });

    const row = reports.rows[0]!;
    expect(row.reporterId).toBe(REPORTER.userId);
    expect(row.reportedUserId).toBe(AUTHOR.userId);
    expect(row.contentSnapshot).toContain("Parking deck rates");
    expect(row.contentSnapshot).toContain(
      "Anyone know what the deck costs now?",
    );
  });

  it("does not create a second row when the same reporter reports the same target again", async () => {
    const { service, reports, postId } = await build();

    await service.create(REPORTER, {
      targetType: "POST",
      targetId: postId,
      reason: "SPAM",
    });
    await service.create(REPORTER, {
      targetType: "POST",
      targetId: postId,
      reason: "HARASSMENT",
      message: "worse than I thought",
    });

    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]!).toMatchObject({
      reason: "HARASSMENT",
      message: "worse than I thought",
    });
  });

  it("does not reopen a report the same reporter already had reviewed", async () => {
    const { service, reports, postId } = await build();
    const input = {
      targetType: "POST" as const,
      targetId: postId,
      reason: "SPAM" as const,
    };

    await service.create(REPORTER, input);
    await reports.resolve({
      reportId: reports.rows[0]!.id,
      status: "REVIEWED",
      reviewedById: "user-mod",
      reviewNote: null,
    });
    await service.create(REPORTER, { ...input, reason: "HARASSMENT" });

    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]!.status).toBe("REVIEWED");
  });

  it("treats a post and a comment with the same id as different targets", async () => {
    const { service, reports, comments, post } = await build();
    const comment = (await comments.insert({
      postId: post.id,
      authorId: AUTHOR.userId,
      content: "Never mind, found it.",
      dateCreated: AT("2026-02-02T00:00:00.000Z"),
    }))!;
    // Force the collision the discriminator exists for.
    comments.rows.find((row) => row.id === comment.id)!.id = post.id;

    await service.create(REPORTER, {
      targetType: "POST",
      targetId: post.id,
      reason: "SPAM",
    });
    await service.create(REPORTER, {
      targetType: "COMMENT",
      targetId: post.id,
      reason: "SPAM",
    });

    expect(reports.rows).toHaveLength(2);
    expect(reports.rows.map((row) => row.targetType).sort()).toEqual([
      "COMMENT",
      "POST",
    ]);
    expect(reports.rows[1]!.contentSnapshot).toBe("Never mind, found it.");
  });

  it("refuses a report on content the reporter cannot see", async () => {
    const { service, host, reports, postId } = await build();
    host.withBlocksFor(REPORTER.userId, [AUTHOR.userId]);

    await expect(
      service.create(REPORTER, {
        targetType: "POST",
        targetId: postId,
        reason: "SPAM",
      }),
    ).rejects.toBeInstanceOf(ContentUnavailableError);
    expect(reports.rows).toHaveLength(0);
  });

  it("refuses a report on content that does not exist", async () => {
    const { service } = await build();

    await expect(
      service.create(REPORTER, {
        targetType: "POST",
        targetId: "post-nope",
        reason: "SPAM",
      }),
    ).rejects.toBeInstanceOf(ContentUnavailableError);
  });

  it("refuses a message longer than the column", async () => {
    const { service, reports, postId } = await build();

    await expect(
      service.create(REPORTER, {
        targetType: "POST",
        targetId: postId,
        reason: "OTHER",
        message: "x".repeat(REPORT_MESSAGE_MAX_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(TextTooLongError);
    expect(reports.rows).toHaveLength(0);
  });

  it("trims a message before storing it", async () => {
    const { service, reports, postId } = await build();

    await service.create(REPORTER, {
      targetType: "POST",
      targetId: postId,
      reason: "OTHER",
      message: "  padded  ",
    });

    expect(reports.rows[0]!.message).toBe("padded");
  });

  it("stores a blank message as null rather than refusing", async () => {
    const { service, reports, postId } = await build();

    await service.create(REPORTER, {
      targetType: "POST",
      targetId: postId,
      reason: "OTHER",
      message: "   ",
    });

    expect(reports.rows[0]!.message).toBeNull();
  });

  it("stores no message as null", async () => {
    const { service, reports, postId } = await build();

    await service.create(REPORTER, {
      targetType: "POST",
      targetId: postId,
      reason: "OTHER",
    });

    expect(reports.rows[0]!.message).toBeNull();
  });

  // Review Focus 2
  it("still lands when the target is hidden between the read and the insert", async () => {
    const { service, targets, reports, posts, postId } = await build();
    targets.hideAfterNextRead();

    await expect(
      service.create(REPORTER, {
        targetType: "POST",
        targetId: postId,
        reason: "SAFETY_CONCERN",
      }),
    ).resolves.toStrictEqual({ acknowledged: true });

    // The hook really did hide it, so the report is evidence of a post that
    // is no longer readable. The sentinel date can only have come from the hook.
    expect(posts.rows.find((row) => row.id === postId)?.hiddenAt).toEqual(
      RACE_HIDDEN_AT,
    );
    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]!.contentSnapshot).toContain("Parking deck rates");
  });
});

describe("auto-hide", () => {
  const REPORT = (postId: string) =>
    ({
      targetType: "POST",
      targetId: postId,
      reason: "HARASSMENT",
    }) as const;

  it("hides the target once three distinct reporters have open reports", async () => {
    const { service, posts, postId } = await build();

    for (const r of [R1, R2]) await service.create(r, REPORT(postId));
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();

    await service.create(R3, REPORT(postId));
    expect(await posts.findVisibleById(postId, [])).toBeNull();
    // Hidden, not deleted: the row is kept.
    expect(posts.rows.find((row) => row.id === postId)?.deletedAt).toBeNull();
  });

  it("stamps the hide with the host's clock", async () => {
    const { service, posts, host, postId } = await build();
    host.setNow(AT("2026-10-21T09:30:00.000Z"));

    for (const r of [R1, R2, R3]) await service.create(r, REPORT(postId));

    expect(posts.rows.find((row) => row.id === postId)?.hiddenAt).toEqual(
      AT("2026-10-21T09:30:00.000Z"),
    );
  });

  // Review Focus 3
  it("does not hide when one reporter reports three times", async () => {
    const { service, reports, posts, postId } = await build();

    for (let i = 0; i < 3; i++) await service.create(R1, REPORT(postId));

    expect(reports.rows).toHaveLength(1);
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
  });

  // Review Focus 4
  it("does not re-hide a target a moderator has dismissed", async () => {
    const { service, reports, posts, postId } = await build();

    for (const r of [R1, R2]) await service.create(r, REPORT(postId));
    await reports.resolve({
      reportId: reports.rows[0]!.id,
      status: "DISMISSED",
      reviewedById: "user-mod",
      reviewNote: null,
    });
    // R2's report is still open, so these two bring the open distinct
    // reporters to three — the count that would hide it had no human looked.
    for (const r of [R3, R4]) await service.create(r, REPORT(postId));

    expect(
      (await reports.countsFor("POST", postId)).distinctOpenReporters,
    ).toBe(3);
    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
  });

  it("does not re-count on a repeat report by an existing reporter", async () => {
    const { service, reports, postId } = await build();

    await service.create(R1, REPORT(postId));
    expect(reports.countsForCalls).toBe(1);

    await service.create(R1, { ...REPORT(postId), reason: "SPAM" });
    expect(reports.countsForCalls).toBe(1);
  });

  it("does not re-hide a target a moderator un-hid when an existing reporter re-reports", async () => {
    const { service, posts, postId } = await build();

    for (const r of [R1, R2, R3]) await service.create(r, REPORT(postId));
    expect(await posts.findVisibleById(postId, [])).toBeNull();

    // A moderator restores it without dismissing anything, so three reporters
    // are still open. Only a re-count on an update could hide it again.
    posts.rows.find((row) => row.id === postId)!.hiddenAt = null;
    await service.create(R1, { ...REPORT(postId), reason: "SPAM" });

    expect(await posts.findVisibleById(postId, [])).not.toBeNull();
  });

  it("tells the reporter nothing about having triggered it", async () => {
    const { service, posts, postId } = await build();

    const first = await service.create(R1, REPORT(postId));
    await service.create(R2, REPORT(postId));
    const third = await service.create(R3, REPORT(postId));

    expect(await posts.findVisibleById(postId, [])).toBeNull();
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    expect(third).toStrictEqual({ acknowledged: true });
  });

  it("hides a comment by the same rule", async () => {
    const { service, comments, post } = await build();
    const comment = (await comments.insert({
      postId: post.id,
      authorId: AUTHOR.userId,
      content: "Spam spam spam.",
      dateCreated: AT("2026-02-02T00:00:00.000Z"),
    }))!;

    for (const r of [R1, R2, R3]) {
      await service.create(r, {
        targetType: "COMMENT",
        targetId: comment.id,
        reason: "SPAM",
      });
    }

    expect(await comments.findVisibleById(comment.id, [])).toBeNull();
    // The post it sits under is untouched.
    expect(post.hiddenAt).toBeNull();
  });
});
