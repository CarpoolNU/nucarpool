import type { NewCursor } from "../shared/cursor";
import type { StoredReport } from "../moderation/ports";
import { FakeReportRepository } from "./fakeReportRepository";

const SAME_MS = new Date("2026-10-01T12:00:00.000Z");

const seed = (
  repo: FakeReportRepository,
  overrides: Partial<Parameters<FakeReportRepository["upsert"]>[0]> = {},
) =>
  repo.upsert({
    reporterId: "reporter-1",
    reportedUserId: "author-1",
    targetType: "POST",
    targetId: "post-1",
    reason: "SPAM",
    message: null,
    contentSnapshot: "snapshot",
    dateCreated: SAME_MS,
    ...overrides,
  });

/** The stored row at an index, failing loudly rather than yielding `undefined`. */
const rowAt = (repo: FakeReportRepository, index: number): StoredReport => {
  const row = repo.rows[index];
  if (!row) {
    throw new Error(`no stored report at index ${index}`);
  }
  return row;
};

describe("FakeReportRepository.upsert", () => {
  it("creates a row, then updates reason and message but never status", async () => {
    const repo = new FakeReportRepository();

    expect(await seed(repo)).toBe("created");
    const created = rowAt(repo, 0);
    await repo.resolve({
      reportId: created.id,
      status: "DISMISSED",
      reviewedById: "mod-1",
      reviewNote: null,
    });

    expect(await seed(repo, { reason: "HARASSMENT", message: "again" })).toBe(
      "updated",
    );

    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      reason: "HARASSMENT",
      message: "again",
      status: "DISMISSED",
    });
  });

  it("keeps the first report's snapshot and date when the same triple is reported again", async () => {
    const repo = new FakeReportRepository();
    const later = new Date("2026-10-02T12:00:00.000Z");

    await seed(repo, { contentSnapshot: "what the reporter saw" });
    expect(
      await seed(repo, {
        reason: "HARASSMENT",
        message: "again",
        contentSnapshot: "what the author edited it into",
        dateCreated: later,
      }),
    ).toBe("updated");

    // The snapshot and date are the evidence a moderator decides on, so an
    // author's edit between two reports must not overwrite them.
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      reason: "HARASSMENT",
      message: "again",
      contentSnapshot: "what the reporter saw",
      dateCreated: SAME_MS,
    });
  });

  it("enforces the unique (reporter, targetType, targetId) triple", async () => {
    const repo = new FakeReportRepository();

    await seed(repo);
    await seed(repo);
    await seed(repo, { targetType: "COMMENT" });
    await seed(repo, { targetId: "post-2" });
    await seed(repo, { reporterId: "reporter-2" });

    expect(repo.rows).toHaveLength(4);
  });
});

describe("FakeReportRepository.countsFor", () => {
  it("counts distinct reporters with an open report, and notices a dismissal", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a" });
    await seed(repo, { reporterId: "b" });
    await seed(repo, { reporterId: "c", targetId: "post-2" });

    expect(await repo.countsFor("POST", "post-1")).toEqual({
      distinctOpenReporters: 2,
      hasDismissedReport: false,
      hasReviewedReport: false,
    });

    await repo.resolve({
      reportId: rowAt(repo, 0).id,
      status: "DISMISSED",
      reviewedById: "mod-1",
      reviewNote: null,
    });

    expect(await repo.countsFor("POST", "post-1")).toEqual({
      distinctOpenReporters: 1,
      hasDismissedReport: true,
      hasReviewedReport: false,
    });
  });

  it("notices a reviewed report, which only a moderator's hide produces", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a" });
    await seed(repo, { reporterId: "b" });

    await repo.resolve({
      reportId: rowAt(repo, 0).id,
      status: "REVIEWED",
      reviewedById: "mod-1",
      reviewNote: null,
    });

    expect(await repo.countsFor("POST", "post-1")).toEqual({
      distinctOpenReporters: 1,
      hasDismissedReport: false,
      hasReviewedReport: true,
    });
  });

  it("does not mix a post and a comment that share an id", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { targetType: "COMMENT", targetId: "x" });

    expect(await repo.countsFor("POST", "x")).toEqual({
      distinctOpenReporters: 0,
      hasDismissedReport: false,
      hasReviewedReport: false,
    });
  });
});

describe("FakeReportRepository.resolve", () => {
  it("lets exactly one of two callers win", async () => {
    const repo = new FakeReportRepository();
    await seed(repo);
    const reportId = rowAt(repo, 0).id;

    const first = await repo.resolve({
      reportId,
      status: "REVIEWED",
      reviewedById: "mod-1",
      reviewNote: "done",
    });
    const second = await repo.resolve({
      reportId,
      status: "DISMISSED",
      reviewedById: "mod-2",
      reviewNote: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await repo.findById(reportId)).toMatchObject({
      status: "REVIEWED",
      reviewedById: "mod-1",
      reviewNote: "done",
    });
  });

  it("returns false for a report that does not exist", async () => {
    const repo = new FakeReportRepository();

    expect(
      await repo.resolve({
        reportId: "nope",
        status: "REVIEWED",
        reviewedById: "mod-1",
        reviewNote: null,
      }),
    ).toBe(false);
  });
});

describe("FakeReportRepository.resolveSiblings", () => {
  it("resolves only the other OPEN reports on the same target", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a" });
    await seed(repo, { reporterId: "b" });
    await seed(repo, { reporterId: "c" });
    await seed(repo, { reporterId: "d", targetId: "post-2" });
    const first = rowAt(repo, 0);
    const second = rowAt(repo, 1);
    await repo.resolve({
      reportId: second.id,
      status: "DISMISSED",
      reviewedById: "mod-0",
      reviewNote: null,
    });

    const moved = await repo.resolveSiblings({
      targetType: "POST",
      targetId: "post-1",
      exceptReportId: first.id,
      status: "REVIEWED",
      reviewedById: "mod-1",
    });

    expect(moved).toBe(1);
    expect(repo.rows.map((row) => row.status)).toEqual([
      "OPEN",
      "DISMISSED",
      "REVIEWED",
      "OPEN",
    ]);
    expect(rowAt(repo, 2).reviewedById).toBe("mod-1");
  });
});

describe("FakeReportRepository.list", () => {
  it("orders by the id tiebreak when three reports share a millisecond", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a" });
    await seed(repo, { reporterId: "b" });
    await seed(repo, { reporterId: "c" });

    const seen: string[] = [];
    let after: NewCursor | null = null;
    for (let page = 0; page < 5; page += 1) {
      const rows: readonly StoredReport[] = await repo.list({
        status: "OPEN",
        after,
        limit: 1,
        urgentOnly: false,
      });
      const [row] = rows;
      if (!row) {
        break;
      }
      seen.push(row.id);
      after = { sort: "new", dateCreated: row.dateCreated, id: row.id };
    }

    const everyId = repo.rows.map((row) => row.id);
    expect([...seen].sort()).toEqual([...everyId].sort());
    expect(new Set(seen).size).toBe(3);
    // Stable and descending by id within the shared millisecond.
    expect(seen).toEqual([...everyId].sort().reverse());
  });

  it("orders newest first across distinct timestamps", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a", dateCreated: new Date(1000) });
    await seed(repo, { reporterId: "b", dateCreated: new Date(3000) });
    await seed(repo, { reporterId: "c", dateCreated: new Date(2000) });

    const rows = await repo.list({
      status: "OPEN",
      after: null,
      limit: 10,
      urgentOnly: false,
    });

    expect(rows.map((row) => row.dateCreated.getTime())).toEqual([
      3000, 2000, 1000,
    ]);
  });

  it("returns only the requested status", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a" });
    await seed(repo, { reporterId: "b" });
    await repo.resolve({
      reportId: rowAt(repo, 1).id,
      status: "DISMISSED",
      reviewedById: "mod-1",
      reviewNote: null,
    });

    const open = await repo.list({
      status: "OPEN",
      after: null,
      limit: 10,
      urgentOnly: false,
    });
    const dismissed = await repo.list({
      status: "DISMISSED",
      after: null,
      limit: 10,
      urgentOnly: false,
    });

    expect(open.map((row) => row.reporterId)).toEqual(["a"]);
    expect(dismissed.map((row) => row.reporterId)).toEqual(["b"]);
  });

  it("honours the limit", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a" });
    await seed(repo, { reporterId: "b" });

    expect(
      await repo.list({
        status: "OPEN",
        after: null,
        limit: 1,
        urgentOnly: false,
      }),
    ).toHaveLength(1);
  });
});

describe("FakeReportRepository urgency parity", () => {
  it("returns only urgent reports when the query asks for them", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a", reason: "SPAM" });
    await seed(repo, { reporterId: "b", reason: "SAFETY_CONCERN" });

    const rows = await repo.list({
      status: "OPEN",
      after: null,
      limit: 10,
      urgentOnly: true,
    });

    expect(rows.map((row) => row.reporterId)).toEqual(["b"]);
  });

  it("counts open urgent reports and ignores resolved ones", async () => {
    const repo = new FakeReportRepository();
    await seed(repo, { reporterId: "a", reason: "SAFETY_CONCERN" });
    await seed(repo, { reporterId: "b", reason: "SAFETY_CONCERN" });
    await seed(repo, { reporterId: "c", reason: "SPAM" });

    expect(await repo.countOpenUrgent()).toBe(2);

    await repo.resolve({
      reportId: rowAt(repo, 0).id,
      status: "REVIEWED",
      reviewedById: "mod-1",
      reviewNote: null,
    });

    // The count is of what is still waiting, so a reviewed safety report
    // leaves it — which is what makes the banner mean "act on this".
    expect(await repo.countOpenUrgent()).toBe(1);
  });
});
