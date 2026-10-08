import { Permission, ReportDigestStatus, ReportReason } from "@prisma/client";
import { integrationPrisma } from "../../testing/integrationDatabase";
import {
  claimDigestWindow,
  DIGEST_CLAIM_LEASE_MS,
  markDigestSent,
  releaseDigestClaim,
} from "./reportDigestDelivery";
import { sendReportDigest } from "../reportDigestSend";
import { previousCompletedWeek } from "../reportDigestWindow";

/**
 * The weekly digest's delivery claim, against a real MySQL.
 *
 * **Why a mocked suite cannot establish any of this.** Every property here is
 * a property of the database rather than of the code around it:
 *
 *  - The claim is an `UPDATE ... WHERE status <> 'SENT' AND (...)` whose
 *    affected-row count *is* the decision. Whether a window that may not be
 *    claimed reports zero rows depends on the statement matching no row rather
 *    than writing an unchanged value — the distinction `CLIENT_FOUND_ROWS`
 *    switches, and only a real server settles it.
 *  - "Exactly one of several concurrent runs wins" is InnoDB serialising on
 *    one row's lock. A fake would report whatever it was written to report.
 *  - `updateMany` looks like the same statement and is not one under
 *    `relationMode = "prisma"`; the test at the bottom demonstrates that
 *    against this database, which is what justifies the raw SQL.
 *
 * `reportDigestSend.test.ts` mocks this module and covers the orchestration
 * around it. This file covers the claim itself.
 *
 * SES is a `jest.fn`, so nothing here sends real email.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

/** A fixed, ordinary 168-hour week: 28 Sep – 4 Oct 2026. */
const NOW = new Date("2026-10-05T12:00:00Z");
const WINDOW = previousCompletedWeek(NOW);

const rowFor = async (windowStart: Date = WINDOW.start) =>
  prisma.reportDigestDelivery.findUnique({ where: { windowStart } });

const newSes = () => jest.fn(async (_command: unknown) => ({ MessageId: "x" }));

/**
 * An admin whose address is deliverable whatever `NEXT_PUBLIC_ENV` says.
 *
 * **Deliberately a gmail.com address.** `isDeliverableRecipient` filters
 * everything except gmail.com when the deploy environment is `staging`, and
 * this suite does *not* mock the env module — it runs whatever the process
 * has. CI's `test-db` job gets the `production` placeholder from
 * `jest.setup.env.js`, but a developer with a populated `.env` can be on
 * `staging`, in which case a `@northeastern.edu` fixture is filtered out and
 * every send here skips with `no_recipients`. That failed locally and would
 * have passed in CI, which is the worst way round.
 *
 * The staging filter itself is covered in `reportDigestSend.test.ts`, which
 * mocks the env and can therefore assert both regimes deliberately.
 */
const makeAdmin = (email = "nucarpool.admin@gmail.com") =>
  prisma.user.create({
    data: { name: "Admin", email, permission: Permission.ADMIN },
  });

/**
 * `relationMode = "prisma"` emulates foreign keys in Prisma rather than MySQL,
 * so a report can name user ids that do not exist. These tests are about the
 * digest's claim and its counting, not about referential integrity, so the ids
 * are plain strings.
 */
const makeReport = (
  reportedUserId: string,
  dateCreated: Date,
  reason: ReportReason = ReportReason.NO_SHOW,
) =>
  prisma.report.create({
    data: {
      reporterId: `reporter-${Math.random().toString(36).slice(2)}`,
      reportedUserId,
      reason,
      dateCreated,
    },
  });

describe("claimDigestWindow", () => {
  it("creates the window row and takes it on a first claim", async () => {
    const claim = await claimDigestWindow(prisma, WINDOW, "token-1", NOW);

    expect(claim).toEqual({ claimed: true, token: "token-1", attempt: 1 });

    const row = await rowFor();
    expect(row).toMatchObject({
      status: ReportDigestStatus.CLAIMED,
      claimToken: "token-1",
      attemptCount: 1,
      sentAt: null,
      reportCount: null,
      recipientCount: null,
    });
    // The window it covers is recorded, not left to be recomputed.
    expect(row?.windowStart).toEqual(WINDOW.start);
    expect(row?.windowEnd).toEqual(WINDOW.end);
  });

  it("refuses a second claim while the first lease is live", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);

    const second = await claimDigestWindow(prisma, WINDOW, "token-2", NOW);

    expect(second).toEqual({
      claimed: false,
      reason: "held_by_another_run",
    });
    // The first run keeps it.
    expect((await rowFor())?.claimToken).toBe("token-1");
  });

  it("refuses a claim on a window already delivered", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);
    await markDigestSent(
      prisma,
      WINDOW,
      "token-1",
      { reportCount: 0, recipientCount: 1 },
      NOW,
    );

    expect(await claimDigestWindow(prisma, WINDOW, "token-2", NOW)).toEqual({
      claimed: false,
      reason: "already_sent",
    });
  });

  /**
   * A run that died without releasing must not lock the window forever, so a
   * claim older than the lease can be taken over. The boundary is asserted on
   * both sides of the lease: a hair inside it is still refused.
   */
  it("lets another run take over an expired claim", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-dead", NOW);

    const justInsideLease = new Date(
      NOW.getTime() + DIGEST_CLAIM_LEASE_MS - 1000,
    );
    expect(
      await claimDigestWindow(prisma, WINDOW, "token-early", justInsideLease),
    ).toMatchObject({ claimed: false, reason: "held_by_another_run" });

    const afterLease = new Date(NOW.getTime() + DIGEST_CLAIM_LEASE_MS + 1000);
    expect(
      await claimDigestWindow(prisma, WINDOW, "token-new", afterLease),
    ).toMatchObject({ claimed: true, token: "token-new" });

    const row = await rowFor();
    expect(row?.claimToken).toBe("token-new");
    // The attempt count carries across the takeover rather than resetting, so
    // the row still says how many runs have tried.
    expect(row?.attemptCount).toBe(2);
  });

  it("counts attempts across retries", async () => {
    for (const token of ["a", "b", "c"]) {
      await claimDigestWindow(prisma, WINDOW, token, NOW);
      await releaseDigestClaim(prisma, WINDOW, token);
    }

    expect((await rowFor())?.attemptCount).toBe(3);
  });

  it("treats each week as its own row", async () => {
    const earlier = previousCompletedWeek(new Date(WINDOW.start.getTime() - 1));

    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);
    const other = await claimDigestWindow(prisma, earlier, "token-2", NOW);

    expect(other.claimed).toBe(true);
    expect(await prisma.reportDigestDelivery.count()).toBe(2);
  });
});

describe("claimDigestWindow under concurrency", () => {
  /**
   * The headline property, and the reason this table exists. Eight runs
   * compute the same window at the same instant — which is what two triggers,
   * or a retry overlapping a slow run, actually looks like — and exactly one
   * may proceed.
   */
  it("admits exactly one of eight simultaneous claims", async () => {
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        claimDigestWindow(prisma, WINDOW, `token-${index}`, NOW),
      ),
    );

    const winners = claims.filter((claim) => claim.claimed);
    expect(winners).toHaveLength(1);

    const losers = claims.filter((claim) => !claim.claimed);
    expect(losers).toHaveLength(7);
    for (const loser of losers) {
      // None of them may conclude the window was already delivered — it was
      // not, and a run that believed so would skip a week for good.
      expect(loser).toMatchObject({ reason: "held_by_another_run" });
    }

    const row = await rowFor();
    expect(row?.status).toBe(ReportDigestStatus.CLAIMED);
    expect(row?.claimToken).toBe(
      (winners[0] as { claimed: true; token: string }).token,
    );
  });

  /**
   * The same property one level up: two whole runs, each reading, counting and
   * sending, produce exactly one email.
   */
  it("sends one digest when two runs race over one week", async () => {
    await makeAdmin();
    await makeReport("user-a", new Date("2026-09-30T12:00:00Z"));

    const first = newSes();
    const second = newSes();

    const outcomes = await Promise.all([
      sendReportDigest(prisma, { send: first }, NOW),
      sendReportDigest(prisma, { send: second }, NOW),
    ]);

    const sent = outcomes.filter((outcome) => outcome.status === "sent");
    expect(sent).toHaveLength(1);
    expect(first.mock.calls.length + second.mock.calls.length).toBe(1);

    const skipped = outcomes.find((outcome) => outcome.status === "skipped");
    expect(skipped).toMatchObject({ reason: "held_by_another_run" });

    expect(await rowFor()).toMatchObject({
      status: ReportDigestStatus.SENT,
      reportCount: 1,
      recipientCount: 1,
    });
  });
});

describe("markDigestSent", () => {
  it("records the delivery and clears the claim", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);

    const sentAt = new Date("2026-10-05T12:00:05Z");
    expect(
      await markDigestSent(
        prisma,
        WINDOW,
        "token-1",
        { reportCount: 4, recipientCount: 2 },
        sentAt,
      ),
    ).toBe(true);

    expect(await rowFor()).toMatchObject({
      status: ReportDigestStatus.SENT,
      sentAt,
      reportCount: 4,
      recipientCount: 2,
      claimToken: null,
    });
  });

  /**
   * The lease-takeover guard. A run whose claim expired, and whose window
   * another run then took, must not be able to mark it delivered — that would
   * overwrite what the new owner is doing.
   */
  it("refuses a token that no longer holds the claim", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-dead", NOW);
    const afterLease = new Date(NOW.getTime() + DIGEST_CLAIM_LEASE_MS + 1000);
    await claimDigestWindow(prisma, WINDOW, "token-new", afterLease);

    expect(
      await markDigestSent(
        prisma,
        WINDOW,
        "token-dead",
        { reportCount: 1, recipientCount: 1 },
        afterLease,
      ),
    ).toBe(false);

    const row = await rowFor();
    expect(row?.status).toBe(ReportDigestStatus.CLAIMED);
    expect(row?.claimToken).toBe("token-new");
    expect(row?.sentAt).toBeNull();
  });

  it("refuses to deliver a window nobody has claimed", async () => {
    expect(
      await markDigestSent(
        prisma,
        WINDOW,
        "token-1",
        { reportCount: 1, recipientCount: 1 },
        NOW,
      ),
    ).toBe(false);
    expect(await rowFor()).toBeNull();
  });

  it("records zero reports as a real delivery", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);
    await markDigestSent(
      prisma,
      WINDOW,
      "token-1",
      { reportCount: 0, recipientCount: 3 },
      NOW,
    );

    // `0`, not null: an empty week was delivered, it was not skipped.
    expect(await rowFor()).toMatchObject({
      status: ReportDigestStatus.SENT,
      reportCount: 0,
    });
  });
});

describe("releaseDigestClaim", () => {
  it("leaves the window retryable and not delivered", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);

    expect(await releaseDigestClaim(prisma, WINDOW, "token-1")).toBe(true);

    expect(await rowFor()).toMatchObject({
      status: ReportDigestStatus.FAILED,
      claimToken: null,
      claimedAt: null,
      sentAt: null,
    });
  });

  /**
   * The retry property. A released window is claimable immediately rather
   * than after the lease, because a send that has already failed should not
   * make the next run wait fifteen minutes to discover the same thing.
   */
  it("allows an immediate retry of the same week", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);
    await releaseDigestClaim(prisma, WINDOW, "token-1");

    const retry = await claimDigestWindow(prisma, WINDOW, "token-2", NOW);

    expect(retry).toMatchObject({ claimed: true, attempt: 2 });
  });

  it("refuses a token that does not hold the claim", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);

    expect(await releaseDigestClaim(prisma, WINDOW, "token-other")).toBe(false);
    expect((await rowFor())?.status).toBe(ReportDigestStatus.CLAIMED);
  });

  it("cannot un-deliver a window that was sent", async () => {
    await claimDigestWindow(prisma, WINDOW, "token-1", NOW);
    await markDigestSent(
      prisma,
      WINDOW,
      "token-1",
      { reportCount: 1, recipientCount: 1 },
      NOW,
    );

    expect(await releaseDigestClaim(prisma, WINDOW, "token-1")).toBe(false);
    expect((await rowFor())?.status).toBe(ReportDigestStatus.SENT);
  });
});

describe("sendReportDigest against a real database", () => {
  it("counts only the reports inside the window", async () => {
    await makeAdmin();

    // Inside: the Monday boundary itself, a midweek day, and the last
    // millisecond of the Sunday.
    await makeReport("user-a", WINDOW.start);
    await makeReport("user-a", new Date("2026-10-01T15:00:00Z"));
    await makeReport(
      "user-b",
      new Date(WINDOW.end.getTime() - 1),
      ReportReason.SAFETY_CONCERN,
    );
    // Outside: one millisecond before the window, and the exclusive end.
    await makeReport("user-c", new Date(WINDOW.start.getTime() - 1));
    await makeReport("user-d", WINDOW.end);

    const send = newSes();
    const outcome = await sendReportDigest(prisma, { send }, NOW);

    expect(outcome).toMatchObject({ status: "sent" });
    const data = JSON.parse(
      (send.mock.calls[0][0] as { input: { TemplateData: string } }).input
        .TemplateData,
    );

    expect(data.reportCount).toBe("3");
    expect(data.uniqueReportedUsers).toBe("2");
    expect(data.repeatedReportedUsers).toBe("1");
    expect(data.highestReportsAboutOneUser).toBe("2");
    expect(data.criticalReports).toBe("1");
    expect(data.windowLabelPlain).toBe("28 Sep – 4 Oct 2026");
  });

  it("does not send the same week twice", async () => {
    await makeAdmin();
    await makeReport("user-a", new Date("2026-09-30T12:00:00Z"));

    const first = newSes();
    expect(await sendReportDigest(prisma, { send: first }, NOW)).toMatchObject({
      status: "sent",
    });

    const second = newSes();
    expect(await sendReportDigest(prisma, { send: second }, NOW)).toMatchObject(
      { status: "skipped", reason: "already_sent" },
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  /**
   * The acceptance criterion that the state only advances on success: a failed
   * send leaves the window retryable, and the retry delivers the same week.
   */
  it("retries the same week after a failed send, then delivers it", async () => {
    await makeAdmin();
    await makeReport("user-a", new Date("2026-09-30T12:00:00Z"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const failing = jest.fn(async (_command: unknown) => {
      throw new Error("TemplateDoesNotExist");
    });
    expect(
      await sendReportDigest(prisma, { send: failing }, NOW),
    ).toMatchObject({ status: "failed", reason: "send_failed" });

    // Not delivered, and retryable.
    expect(await rowFor()).toMatchObject({
      status: ReportDigestStatus.FAILED,
      sentAt: null,
      reportCount: null,
    });

    const succeeding = newSes();
    const retry = await sendReportDigest(prisma, { send: succeeding }, NOW);

    expect(retry).toMatchObject({ status: "sent" });
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(await rowFor()).toMatchObject({
      status: ReportDigestStatus.SENT,
      reportCount: 1,
    });

    jest.restoreAllMocks();
  });

  it("releases the claim when no admin is reachable", async () => {
    await makeReport("user-a", new Date("2026-09-30T12:00:00Z"));

    const send = newSes();
    expect(await sendReportDigest(prisma, { send }, NOW)).toMatchObject({
      status: "skipped",
      reason: "no_recipients",
    });

    expect(send).not.toHaveBeenCalled();
    expect((await rowFor())?.status).toBe(ReportDigestStatus.FAILED);

    // And once somebody is staff, the same week still goes out.
    await makeAdmin();
    const retry = newSes();
    expect(await sendReportDigest(prisma, { send: retry }, NOW)).toMatchObject({
      status: "sent",
    });
  });
});

/**
 * Why the claim is raw SQL.
 *
 * `updateMany` reads as the same statement and is not one under
 * `relationMode = "prisma"`: Prisma resolves the matching ids first and then
 * updates by id, so concurrent callers all match the row before any of them
 * changes it and every one reports `count: 1`. The same holds for the sibling
 * writes this table's claim is modelled on; this pins it for *this* table, so
 * that anyone tempted to simplify `claimDigestWindow` into a `updateMany` has
 * a failing test explaining why not.
 *
 * It asserts a Prisma behaviour rather than this repository's code, and that
 * is deliberate — the behaviour is the premise the design rests on. If a
 * future Prisma makes `updateMany` a true compare-and-swap, this test fails
 * and the raw SQL becomes a choice rather than a necessity.
 */
describe("why the claim is not updateMany", () => {
  it("lets every concurrent updateMany believe it won", async () => {
    await prisma.reportDigestDelivery.create({
      data: {
        windowStart: WINDOW.start,
        windowEnd: WINDOW.end,
        status: ReportDigestStatus.PENDING,
      },
    });

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        prisma.reportDigestDelivery.updateMany({
          where: {
            windowStart: WINDOW.start,
            status: ReportDigestStatus.PENDING,
          },
          data: {
            status: ReportDigestStatus.CLAIMED,
            claimToken: `token-${index}`,
          },
        }),
      ),
    );

    // More than one "winner" — which, used as a claim, would be more than one
    // digest for the same week.
    expect(
      results.filter((result) => result.count === 1).length,
    ).toBeGreaterThan(1);

    // The raw claim on the same starting state admits exactly one. Reset the
    // row first so the two are compared from the same place.
    await prisma.reportDigestDelivery.update({
      where: { windowStart: WINDOW.start },
      data: {
        status: ReportDigestStatus.PENDING,
        claimToken: null,
        claimedAt: null,
      },
    });

    const claims = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        claimDigestWindow(prisma, WINDOW, `raw-${index}`, NOW),
      ),
    );

    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
  });
});
