import { Permission, ReportReason } from "@prisma/client";

/**
 * The weekly digest's orchestration: the order the pieces run in, and what
 * reaches SES.
 *
 * **The delivery claim is mocked here and tested for real in
 * `db/reportDigestDelivery.db.test.ts`.** The split is deliberate. The claim's
 * interesting properties are the ones only MySQL can demonstrate — that of two
 * concurrent `UPDATE`s exactly one is affected, and that `updateMany` would not
 * behave the same way — so asserting them against a fake would prove the fake.
 * What belongs here is the half a fake *can* establish: that a refused claim
 * stops the send, that a failed send releases the claim and never marks the
 * window delivered, and that no word of a report reaches the email.
 *
 * `NEXT_PUBLIC_ENV` is mocked as a getter rather than assigned on
 * `process.env`, because envsafe reads it once at import time — the approach
 * `email.test.ts` established.
 */

let deployEnv = "production";

jest.mock("../utils/env/browser", () => ({
  browserEnv: {
    get NEXT_PUBLIC_ENV() {
      return deployEnv;
    },
  },
}));

/**
 * Mocked so the orchestration can be driven through each claim outcome. The
 * real implementations are exercised against a live database in the sibling
 * `.db.test.ts`.
 */
jest.mock("./db/reportDigestDelivery", () => ({
  claimDigestWindow: jest.fn(),
  markDigestSent: jest.fn(),
  releaseDigestClaim: jest.fn(),
  DIGEST_CLAIM_LEASE_MS: 15 * 60 * 1000,
}));

/**
 * Not imported by `reportDigestSend.ts` at all — which is the point. The
 * digest must never be charged to the per-sender email budget, and a future
 * edit that started claiming one would show up as a call here rather than as
 * a silent behaviour change.
 */
jest.mock("./db/emailBudget", () => ({
  claimEmailBudget: jest.fn(async () => ({
    claimed: true,
    refund: async () => undefined,
  })),
  budgetWindowStart: jest.fn(),
  EMAIL_BUDGET_WINDOW_MS: 60 * 60 * 1000,
  EMAILS_PER_BUDGET_WINDOW: 20,
}));

import {
  claimDigestWindow,
  markDigestSent,
  releaseDigestClaim,
} from "./db/reportDigestDelivery";
import { claimEmailBudget } from "./db/emailBudget";
import {
  collectDigestRows,
  previewReportDigest,
  REPORT_DIGEST_SEND_WHEN_EMPTY,
  sendReportDigest,
  type ReportDigestPrisma,
} from "./reportDigestSend";
import { previousCompletedWeek } from "./reportDigestWindow";

const mockClaim = claimDigestWindow as jest.MockedFunction<
  typeof claimDigestWindow
>;
const mockMarkSent = markDigestSent as jest.MockedFunction<
  typeof markDigestSent
>;
const mockRelease = releaseDigestClaim as jest.MockedFunction<
  typeof releaseDigestClaim
>;

const TOKEN = "test-token";
/** A Monday 08:00 ET run; the week it covers is 28 Sep – 4 Oct 2026. */
const NOW = new Date("2026-10-05T12:00:00Z");

type ReportRow = { reportedUserId: string; reason: ReportReason };

const buildPrisma = (
  reports: ReportRow[],
  admins: { email: string | null; permission?: Permission }[] = [
    { email: "admin@northeastern.edu" },
  ],
) => {
  // The parameters are declared, unused, so that `mock.calls[0][0]` is typed
  // as the query object these tests assert on rather than as `undefined`.
  const reportFindMany = jest.fn(async (_args?: unknown) => reports);
  const userFindMany = jest.fn(async (_args?: unknown) =>
    admins.map(({ email }) => ({ email })),
  );
  const executeRaw = jest.fn(async (..._args: unknown[]) => 1);

  const prisma = {
    report: { findMany: reportFindMany },
    user: { findMany: userFindMany },
    $executeRaw: executeRaw,
    reportDigestDelivery: { findUnique: jest.fn(async () => null) },
  } as unknown as ReportDigestPrisma;

  return { prisma, reportFindMany, userFindMany, executeRaw };
};

/** A `SendTemplatedEmailCommand`, as far as these tests look into one. */
type SentCommand = {
  input: {
    Template: string;
    Destination: { ToAddresses: string[] };
    TemplateData: string;
  };
};

const buildSes = () => {
  const send = jest.fn(async (_command: SentCommand) => ({}));
  return { ses: { send }, send };
};

/** The `TemplateData` of the one command SES was handed. */
const sentData = (
  send: ReturnType<typeof buildSes>["send"],
): Record<string, string> =>
  JSON.parse(send.mock.calls[0][0].input.TemplateData);

beforeEach(() => {
  deployEnv = "production";
  jest.clearAllMocks();
  mockClaim.mockResolvedValue({ claimed: true, token: TOKEN, attempt: 1 });
  mockMarkSent.mockResolvedValue(true);
  mockRelease.mockResolvedValue(true);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("collectDigestRows", () => {
  /**
   * The privacy boundary at the query level: the content is never fetched, so
   * no later edit can interpolate a value this read did not retrieve.
   */
  it("selects only the two columns the aggregation may see", async () => {
    const { prisma, reportFindMany } = buildPrisma([]);
    const window = previousCompletedWeek(NOW);

    await collectDigestRows(prisma, window);

    expect(reportFindMany).toHaveBeenCalledWith({
      where: { dateCreated: { gte: window.start, lt: window.end } },
      select: { reportedUserId: true, reason: true },
    });

    const { select } = reportFindMany.mock.calls[0][0] as {
      select: Record<string, boolean>;
    };
    expect(Object.keys(select).sort()).toEqual(["reason", "reportedUserId"]);
  });

  /**
   * Half-open, so a report filed at the exact Monday midnight belongs to the
   * week opening and is counted once rather than in both digests.
   */
  it("bounds the read half-open on the window", async () => {
    const { prisma, reportFindMany } = buildPrisma([]);
    const window = previousCompletedWeek(NOW);

    await collectDigestRows(prisma, window);

    const { where } = reportFindMany.mock.calls[0][0] as {
      where: { dateCreated: { gte: Date; lt: Date } };
    };
    expect(where.dateCreated.gte).toEqual(window.start);
    expect(where.dateCreated.lt).toEqual(window.end);
    expect(where.dateCreated).not.toHaveProperty("lte");
  });
});

describe("previewReportDigest", () => {
  it("summarises the week without claiming or sending anything", async () => {
    const { prisma, executeRaw } = buildPrisma([
      { reportedUserId: "user-a", reason: ReportReason.NO_SHOW },
      { reportedUserId: "user-a", reason: ReportReason.HARASSMENT },
      { reportedUserId: "user-b", reason: ReportReason.SAFETY_CONCERN },
    ]);

    const preview = await previewReportDigest(prisma, NOW);

    expect(preview.windowLabel).toBe("28 Sep – 4 Oct 2026");
    expect(preview.summary.reportCount).toBe(3);
    expect(preview.summary.repeatedReportedUserCount).toBe(1);
    expect(preview.recipientCount).toBe(1);

    // A dry run writes nothing at all.
    expect(mockClaim).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("reports zero recipients rather than failing when there are no admins", async () => {
    const { prisma } = buildPrisma([], []);

    await expect(previewReportDigest(prisma, NOW)).resolves.toMatchObject({
      recipientCount: 0,
    });
  });
});

describe("sendReportDigest", () => {
  it("sends the week's counts to every admin", async () => {
    const { prisma } = buildPrisma(
      [
        { reportedUserId: "user-a", reason: ReportReason.NO_SHOW },
        { reportedUserId: "user-a", reason: ReportReason.NO_SHOW },
        { reportedUserId: "user-b", reason: ReportReason.SAFETY_CONCERN },
      ],
      [
        { email: "admin@northeastern.edu" },
        { email: "manager@northeastern.edu" },
      ],
    );
    const { ses, send } = buildSes();

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);

    const input = send.mock.calls[0][0].input;
    expect(input.Template).toBe("AdminReportDigestTemplate");
    expect(input.Destination.ToAddresses).toEqual([
      "admin@northeastern.edu",
      "manager@northeastern.edu",
    ]);

    expect(sentData(send)).toMatchObject({
      windowLabelPlain: "28 Sep – 4 Oct 2026",
      reportCount: "3",
      uniqueReportedUsers: "2",
      repeatedReportedUsers: "1",
      highestReportsAboutOneUser: "2",
      criticalReports: "1",
      reasonBreakdownPlain: "Safety concern: 1, Didn't show up: 2",
    });
  });

  /**
   * The exact key set, for the same reason the immediate alert has one: the
   * risk is a future edit quietly passing a reporter's message or a user id
   * through, and a test that only forbade today's field names would not catch
   * a new one.
   */
  it("puts nothing in TemplateData but counts and two written strings", async () => {
    const { prisma } = buildPrisma([
      { reportedUserId: "user-a", reason: ReportReason.NO_SHOW },
    ]);
    const { ses, send } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(Object.keys(sentData(send)).sort()).toEqual([
      "criticalReports",
      "highestReportsAboutOneUser",
      "reasonBreakdownHtml",
      "reasonBreakdownPlain",
      "repeatedReportedUsers",
      "reportCount",
      "uniqueReportedUsers",
      "windowLabelHtml",
      "windowLabelPlain",
    ]);
  });

  /**
   * The acceptance criterion that matters most. The reported user ids are
   * distinctive strings and the *whole* serialised command is searched — not
   * only `TemplateData`, because a subject or an address built from a report
   * would be as much of a disclosure.
   */
  it("discloses no reported user's identity anywhere in the command", async () => {
    const { prisma } = buildPrisma([
      { reportedUserId: "UNIQUE-REPORTED-ID-A", reason: ReportReason.NO_SHOW },
      { reportedUserId: "UNIQUE-REPORTED-ID-A", reason: ReportReason.NO_SHOW },
      {
        reportedUserId: "UNIQUE-REPORTED-ID-B",
        reason: ReportReason.HARASSMENT,
      },
    ]);
    const { ses, send } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    const serialised = JSON.stringify(send.mock.calls[0][0].input);
    expect(serialised).not.toContain("UNIQUE-REPORTED-ID-A");
    expect(serialised).not.toContain("UNIQUE-REPORTED-ID-B");

    // The control: the repetition those ids describe *is* reported, so the
    // assertions above are about anonymity rather than about an empty email.
    expect(sentData(send).repeatedReportedUsers).toBe("1");
    expect(sentData(send).highestReportsAboutOneUser).toBe("2");
  });

  it("sends a digest for a week with no reports", async () => {
    const { prisma } = buildPrisma([]);
    const { ses, send } = buildSes();

    // Guards the branch below: if this constant is ever flipped, the
    // expectation here is wrong rather than silently vacuous.
    expect(REPORT_DIGEST_SEND_WHEN_EMPTY).toBe(true);

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sentData(send)).toMatchObject({
      reportCount: "0",
      uniqueReportedUsers: "0",
      repeatedReportedUsers: "0",
      highestReportsAboutOneUser: "0",
      criticalReports: "0",
      reasonBreakdownPlain: "No reports this week",
    });
  });

  it("marks the window delivered only after the send resolves", async () => {
    const order: string[] = [];
    const { prisma } = buildPrisma([]);
    const send = jest.fn(async () => {
      order.push("send");
      return {};
    });
    mockMarkSent.mockImplementation(async () => {
      order.push("markSent");
      return true;
    });

    await sendReportDigest(prisma, { send }, NOW, { token: TOKEN });

    expect(order).toEqual(["send", "markSent"]);
    expect(mockMarkSent).toHaveBeenCalledWith(
      prisma,
      previousCompletedWeek(NOW),
      TOKEN,
      { reportCount: 0, recipientCount: 1 },
      NOW,
    );
  });

  it("claims the window before reading anything", async () => {
    const order: string[] = [];
    const { prisma, reportFindMany } = buildPrisma([]);
    reportFindMany.mockImplementation(async () => {
      order.push("read");
      return [];
    });
    mockClaim.mockImplementation(async () => {
      order.push("claim");
      return { claimed: true, token: TOKEN, attempt: 1 };
    });
    const { ses } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(order).toEqual(["claim", "read"]);
  });
});

describe("sendReportDigest duplicate and concurrency protection", () => {
  it("sends nothing when the window has already been delivered", async () => {
    const { prisma, reportFindMany } = buildPrisma([]);
    const { ses, send } = buildSes();
    mockClaim.mockResolvedValue({ claimed: false, reason: "already_sent" });

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome).toEqual({
      status: "skipped",
      window: previousCompletedWeek(NOW),
      reason: "already_sent",
    });
    expect(send).not.toHaveBeenCalled();
    // Not even the read: a refused claim stops the whole run.
    expect(reportFindMany).not.toHaveBeenCalled();
    expect(mockMarkSent).not.toHaveBeenCalled();
  });

  it("sends nothing while another run holds the claim", async () => {
    const { prisma } = buildPrisma([]);
    const { ses, send } = buildSes();
    mockClaim.mockResolvedValue({
      claimed: false,
      reason: "held_by_another_run",
    });

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "held_by_another_run",
    });
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * The one outcome that needs a human: the mail was accepted but the claim
   * had been taken over, so the delivery could not be written down. It must
   * not be reported as sent, and it must not force the row.
   */
  it("reports a lost claim rather than claiming success", async () => {
    const { prisma } = buildPrisma([]);
    const { ses, send } = buildSes();
    mockMarkSent.mockResolvedValue(false);

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "state_not_recorded",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("sendReportDigest when the send fails", () => {
  it("does not mark the window delivered", async () => {
    const { prisma } = buildPrisma([]);
    const send = jest.fn(async () => {
      throw new Error("TemplateDoesNotExist");
    });

    const outcome = await sendReportDigest(prisma, { send }, NOW, {
      token: TOKEN,
    });

    expect(outcome).toMatchObject({ status: "failed", reason: "send_failed" });
    expect(mockMarkSent).not.toHaveBeenCalled();
  });

  it("releases the claim so the same week is retried", async () => {
    const { prisma } = buildPrisma([]);
    const send = jest.fn(async () => {
      throw new Error("TemplateDoesNotExist");
    });

    await sendReportDigest(prisma, { send }, NOW, { token: TOKEN });

    expect(mockRelease).toHaveBeenCalledWith(
      prisma,
      previousCompletedWeek(NOW),
      TOKEN,
    );
  });

  it("resolves rather than rejecting, so no caller has to catch", async () => {
    const { prisma } = buildPrisma([]);
    const send = jest.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      sendReportDigest(prisma, { send }, NOW, { token: TOKEN }),
    ).resolves.toBeDefined();
  });

  /** A read failure is handled on the same path as a send failure. */
  it("releases the claim when the report read fails", async () => {
    const { prisma, reportFindMany } = buildPrisma([]);
    reportFindMany.mockRejectedValue(new Error("connection lost"));
    const { ses, send } = buildSes();

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome).toMatchObject({ status: "failed", reason: "send_failed" });
    expect(send).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  /**
   * A failure to release must not mask the failure that caused it, and the
   * window is still retried because an unreleased claim expires on its own.
   */
  it("still reports the send failure when releasing the claim also fails", async () => {
    const { prisma } = buildPrisma([]);
    const send = jest.fn(async () => {
      throw new Error("TemplateDoesNotExist");
    });
    mockRelease.mockRejectedValue(new Error("connection lost"));

    await expect(
      sendReportDigest(prisma, { send }, NOW, { token: TOKEN }),
    ).resolves.toMatchObject({ status: "failed", reason: "send_failed" });
  });
});

describe("sendReportDigest recipient resolution", () => {
  it("addresses every user whose permission is not USER", async () => {
    const { prisma, userFindMany } = buildPrisma([]);
    const { ses } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(userFindMany).toHaveBeenCalledWith({
      where: { permission: { not: Permission.USER } },
      select: { email: true },
    });
  });

  it("skips users with no address on record", async () => {
    const { prisma } = buildPrisma(
      [],
      [{ email: null }, { email: "admin@northeastern.edu" }],
    );
    const { ses, send } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(send.mock.calls[0][0].input.Destination.ToAddresses).toEqual([
      "admin@northeastern.edu",
    ]);
  });

  /**
   * Staging may only mail gmail.com. Filtered rather than thrown, so a digest
   * is still delivered to whoever is reachable.
   */
  it("mails only gmail addresses on staging", async () => {
    deployEnv = "staging";
    const { prisma } = buildPrisma(
      [],
      [{ email: "admin@northeastern.edu" }, { email: "admin@gmail.com" }],
    );
    const { ses, send } = buildSes();

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome.status).toBe("sent");
    expect(send.mock.calls[0][0].input.Destination.ToAddresses).toEqual([
      "admin@gmail.com",
    ]);
  });

  /**
   * A roster with nobody reachable is a real state, not a fault. The claim is
   * released so a roster corrected later still gets this week's digest.
   */
  it("skips and releases the claim when nobody is reachable", async () => {
    deployEnv = "staging";
    const { prisma } = buildPrisma([], [{ email: "admin@northeastern.edu" }]);
    const { ses, send } = buildSes();

    const outcome = await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(outcome).toMatchObject({
      status: "skipped",
      reason: "no_recipients",
    });
    expect(send).not.toHaveBeenCalled();
    expect(mockMarkSent).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledWith(
      prisma,
      previousCompletedWeek(NOW),
      TOKEN,
    );
  });
});

describe("the digest's email budget", () => {
  /**
   * It claims none. Charging a sender's budget is meaningless here — there is
   * no sender, and the recipients are staff resolved from `Permission` rather
   * than an address anyone can choose, so the abuse the budget prevents cannot
   * happen on this path. A global cap would be worse: it would be spendable by
   * whatever else claimed it, and could silence a week's digest.
   */
  it("never claims a per-sender email budget", async () => {
    const { prisma } = buildPrisma([
      { reportedUserId: "user-a", reason: ReportReason.NO_SHOW },
    ]);
    const { ses, send } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    expect(send).toHaveBeenCalledTimes(1);
    expect(claimEmailBudget).not.toHaveBeenCalled();
  });

  it("writes nothing to the budget table", async () => {
    const { prisma, executeRaw } = buildPrisma([]);
    const { ses } = buildSes();

    await sendReportDigest(prisma, ses, NOW, { token: TOKEN });

    const statements = executeRaw.mock.calls.map((call) =>
      JSON.stringify(call),
    );
    expect(
      statements.filter((statement) => statement.includes("email_send_budget")),
    ).toEqual([]);
  });
});
