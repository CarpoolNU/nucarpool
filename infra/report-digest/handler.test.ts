/**
 * The EventBridge Scheduler adapter.
 *
 * **What this file can establish is narrow on purpose.** The digest's real
 * behaviour — the window arithmetic across both DST transitions, the
 * compare-and-swap that makes a double run send once, the counts, and what
 * reaches SES — is covered by `reportDigestWindow.test.ts`,
 * `reportDigestSend.test.ts` and `reportDigestDelivery.db.test.ts`, the last of
 * those against a real MySQL. Re-asserting any of it here would only prove the
 * mock.
 *
 * So `sendReportDigest` is mocked, and every test below is about the three
 * things the adapter itself decides:
 *
 *   - which week it asks for, and that it asks rather than deriving one;
 *   - that a malformed payload is refused before anything is claimed or sent;
 *   - which outcomes throw, because a thrown error is the only thing that
 *     reaches the CloudWatch alarm.
 *
 * ## On "refuses an unauthenticated caller"
 *
 * A Lambda invoked by EventBridge Scheduler has no in-code authentication to
 * test: the only principal that may invoke it is the
 * scheduler role named in `template.yaml`, enforced by IAM before this code
 * runs, and there is no HTTP surface and no shared secret. The nearest real
 * equivalent is the payload check — the one untrusted input a console
 * invocation can supply — which is why `week` is validated and tested here.
 */

import {
  previousCompletedWeek,
  weekContaining,
} from "../../src/server/reportDigestWindow";
import type { ReportDigestSummary } from "../../src/server/reportDigest";
import type {
  DigestRunOutcome,
  ReportDigestPrisma,
} from "../../src/server/reportDigestSend";

jest.mock("../../src/server/reportDigestSend", () => ({
  sendReportDigest: jest.fn(),
  previewReportDigest: jest.fn(),
}));

import { sendReportDigest } from "../../src/server/reportDigestSend";
import { runReportDigest, type ReportDigestDeps } from "./handler";

const mockSend = sendReportDigest as jest.MockedFunction<
  typeof sendReportDigest
>;

/** A Monday 08:00 ET run. The week it covers is 28 Sep – 4 Oct 2026. */
const NOW = new Date("2026-10-05T12:00:00Z");

/**
 * Opaque sentinels rather than fakes with methods.
 *
 * The adapter's contract is that it hands these straight to `sendReportDigest`
 * and queries nothing itself, so identity is the whole assertion — and a
 * sentinel cannot accidentally satisfy a call the adapter should not be making.
 */
const prisma = { sentinel: "prisma" } as unknown as ReportDigestPrisma;
const ses = { send: jest.fn() };
const deps: ReportDigestDeps = { prisma, ses };

const SUMMARY: ReportDigestSummary = {
  reportCount: 3,
  uniqueReportedUserCount: 2,
  repeatedReportedUserCount: 1,
  highestReportsAboutOneUser: 2,
  criticalReportCount: 0,
  countsByReason: [],
};

const sentOutcome = (): DigestRunOutcome => ({
  status: "sent",
  attempt: 1,
  window: previousCompletedWeek(NOW),
  windowLabel: "28 Sep – 4 Oct 2026",
  summary: SUMMARY,
  recipientCount: 4,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("which week the invocation covers", () => {
  it("asks for the previous completed week when the payload is empty", async () => {
    mockSend.mockResolvedValue(sentOutcome());

    await runReportDigest(deps, {}, NOW);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][3]).toEqual({
      window: previousCompletedWeek(NOW),
    });
  });

  it.each([
    ["an absent payload", null],
    ["a payload with no week", {} as const],
    ["an explicit undefined", { week: undefined }],
  ])("derives the week from the calendar for %s", async (_label, event) => {
    mockSend.mockResolvedValue(sentOutcome());

    await runReportDigest(deps, event, NOW);

    expect(mockSend.mock.calls[0][3]).toEqual({
      window: previousCompletedWeek(NOW),
    });
  });

  it("sends a named past week, read at noon so the date is not off by one", async () => {
    mockSend.mockResolvedValue(sentOutcome());

    await runReportDigest(deps, { week: "2026-09-07" }, NOW);

    // `weekContaining` of noon UTC on that date. Midnight would land on the
    // preceding Sunday evening in America/New_York and select the week before.
    expect(mockSend.mock.calls[0][3]).toEqual({
      window: weekContaining(new Date("2026-09-07T12:00:00Z")),
    });
  });

  it("passes the clock through, so a late run still covers its own week", async () => {
    mockSend.mockResolvedValue(sentOutcome());

    // Wednesday, two days after the schedule should have fired.
    const late = new Date("2026-10-07T12:00:00Z");
    await runReportDigest(deps, {}, late);

    expect(mockSend.mock.calls[0][2]).toBe(late);
    expect(mockSend.mock.calls[0][3]).toEqual({
      window: previousCompletedWeek(late),
    });
  });
});

describe("it adapts rather than reimplementing the job", () => {
  it("hands its own clients to sendReportDigest untouched", async () => {
    mockSend.mockResolvedValue(sentOutcome());

    await runReportDigest(deps, {}, NOW);

    expect(mockSend.mock.calls[0][0]).toBe(prisma);
    expect(mockSend.mock.calls[0][1]).toBe(ses);
  });

  it("claims nothing and sends nothing on its own", async () => {
    mockSend.mockResolvedValue(sentOutcome());

    await runReportDigest(deps, {}, NOW);

    // The only SES call in the whole path belongs to `sendReportDigest`, which
    // is mocked here — so a call on this sentinel could only have come from the
    // adapter, and would mean a second copy of the send had appeared.
    expect(ses.send).not.toHaveBeenCalled();
  });

  it("returns the outcome unchanged", async () => {
    const outcome = sentOutcome();
    mockSend.mockResolvedValue(outcome);

    await expect(runReportDigest(deps, {}, NOW)).resolves.toBe(outcome);
  });
});

describe("a malformed payload is refused before anything is claimed", () => {
  it.each(["2026-9-7", "last week", "", "2026-09-07T00:00:00Z", "28 Sep 2026"])(
    "rejects %p",
    async (week) => {
      await expect(runReportDigest(deps, { week }, NOW)).rejects.toThrow(
        /--week needs a date like/,
      );

      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a number", 20260907],
    ["an object", { from: "2026-09-07" }],
    ["an array", ["2026-09-07"]],
    ["a boolean", true],
  ])("rejects %s", async (_label, week) => {
    await expect(runReportDigest(deps, { week }, NOW)).rejects.toThrow(
      /must be a string/,
    );

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("which outcomes reach the alarm", () => {
  it.each([
    ["already_sent", "a second run in the same week"],
    ["held_by_another_run", "two runs at once"],
    ["no_recipients", "an empty admin roster"],
    ["empty_week", "a week with no reports"],
  ] as const)("returns without throwing for %s (%s)", async (reason, _case) => {
    mockSend.mockResolvedValue({
      status: "skipped",
      window: previousCompletedWeek(NOW),
      reason,
    });

    await expect(runReportDigest(deps, {}, NOW)).resolves.toMatchObject({
      status: "skipped",
      reason,
    });
  });

  it("throws when the send failed, so the Errors metric records it", async () => {
    mockSend.mockResolvedValue({
      status: "failed",
      window: previousCompletedWeek(NOW),
      reason: "send_failed",
    });

    await expect(runReportDigest(deps, {}, NOW)).rejects.toThrow(
      /was not sent[\s\S]*retries the same week/,
    );
  });

  it("throws and names the week when the delivery was not recorded", async () => {
    mockSend.mockResolvedValue({
      status: "failed",
      window: previousCompletedWeek(NOW),
      reason: "state_not_recorded",
    });

    await expect(runReportDigest(deps, {}, NOW)).rejects.toThrow(
      /report_digest_delivery for window_start 2026-09-28T04:00:00\.000Z/,
    );
  });
});
