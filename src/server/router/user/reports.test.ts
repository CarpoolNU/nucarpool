import { Permission, ReportReason, ReportStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";
import { BLOCK_GROUP_MEMBER_MESSAGE } from "./blocks";
import {
  DUPLICATE_REPORT_MESSAGE,
  REPORT_RATE_LIMIT_MESSAGE,
  REPORT_REQUEST_MISMATCH_MESSAGE,
} from "./reports";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import { REPORT_SNAPSHOT_MESSAGE_LIMIT } from "../../../utils/reports";

/**
 * `user.reports.create`.
 *
 * The fake keeps reports, blocks and messages in memory, and its
 * `$transaction` restores both lists when the callback throws, so a test can
 * assert what was actually saved rather than which calls were made. Real
 * persistence, and surviving `requests.delete`, are in `reports.db.test.ts`.
 */

const ME = "user-me";
const THEM = "user-them";
const OTHER = "user-other";
/** Someone with neither name set, for `me`'s "Unknown user" fallback. */
const NAMELESS = "user-nameless";
/** Where the admin alert goes. Not a user in `USER_NAMES`: the alert resolves
 *  its recipients by `permission`, not from anything a report references. */
const ADMIN_EMAIL = "admin@northeastern.edu";

/**
 * The users the fake knows, and the names `reports.me` resolves through.
 *
 * `OTHER` has no preferred name and `NAMELESS` has neither, which is the
 * `preferredName || name || "Unknown user"` chain `blocks.me` established.
 */
const USER_NAMES: Record<
  string,
  { preferredName: string | null; name: string | null }
> = {
  [ME]: { preferredName: "Me", name: "Me Full" },
  [THEM]: { preferredName: "Them", name: "Them Full" },
  [OTHER]: { preferredName: null, name: "Other Full" },
  [NAMELESS]: { preferredName: null, name: null },
};

type ReportRow = {
  id: string;
  reporterId: string;
  reportedUserId: string;
  reason: ReportReason;
  message: string | null;
  requestId: string | null;
  conversationSnapshot: string | null;
  status: ReportStatus;
  dateCreated?: Date;
  dateModified?: Date;
};
type BlockRow = { blockerId: string; blockedId: string };
type MessageRow = {
  id: string;
  requestId: string;
  userId: string;
  content: string;
  dateCreated: Date;
};

const buildReportsDb = (opts?: {
  requests?: Record<string, { fromUserId: string; toUserId: string }>;
  messages?: MessageRow[];
  reports?: ReportRow[];
  carpoolIds?: Record<string, string | null>;
  upsertFails?: boolean;
}) => {
  const users = new Map(Object.entries(USER_NAMES));
  const requests = opts?.requests ?? {};
  const messages = opts?.messages ?? [];
  const reports: ReportRow[] = opts?.reports ?? [];
  const blocks: BlockRow[] = [];
  const carpoolIds = opts?.carpoolIds ?? {};

  const client = {
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        users.has(where.id) ? { id: where.id } : null,
      ),
      // The admin roster `notifyAdminsOfReport` mails after a successful
      // create. Every test in this file goes through that path, so the fake
      // supplies one rather than leaving each one to log a caught failure.
      findMany: jest.fn(async () => [{ email: ADMIN_EMAIL }]),
    },
    request: {
      findUnique: jest.fn(async ({ where }: any) => requests[where.id] ?? null),
    },
    message: {
      findMany: jest.fn(async ({ where, take }: any) =>
        messages
          .filter((m) => m.requestId === where.conversation.requestId)
          .sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime())
          .slice(0, take)
          .map(({ userId, content, dateCreated }) => ({
            userId,
            content,
            dateCreated,
          })),
      ),
    },
    report: {
      // `me` reads this: the caller's rows, newest first, with the
      // reported user's names joined on. `dateCreated` falls back to "now"
      // as `count` below does, for the fixtures that seed reports without
      // one.
      findMany: jest.fn(async ({ where }: any) =>
        reports
          .filter((r) => r.reporterId === where.reporterId)
          .sort((a, b) => {
            const byDate =
              (b.dateCreated ?? new Date()).getTime() -
              (a.dateCreated ?? new Date()).getTime();
            return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
          })
          .map((r) => ({
            ...r,
            dateModified: r.dateModified ?? r.dateCreated ?? new Date(),
            reportedUser: users.get(r.reportedUserId) ?? {
              preferredName: null,
              name: null,
            },
          })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const match = reports.find(
          (r) =>
            r.reporterId === where.reporterId &&
            r.reportedUserId === where.reportedUserId &&
            r.status === where.status,
        );
        return match ? { id: match.id } : null;
      }),
      // A missing `dateCreated` reads as "now": every existing fixture in
      // this file seeds reports with no timestamp at all, and they represent
      // reports that are still current for whatever that test is checking.
      count: jest.fn(
        async ({ where }: any) =>
          reports.filter(
            (r) =>
              r.reporterId === where.reporterId &&
              (r.dateCreated ?? new Date()).getTime() >=
                where.dateCreated.gte.getTime(),
          ).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `report-${reports.length + 1}`,
          status: ReportStatus.OPEN,
          dateCreated: new Date(),
          ...data,
        };
        reports.push(row);
        return { id: row.id };
      }),
    },
    // `applyBlock`'s group-membership check is a locking `$queryRaw`, not
    // `carpoolSearch.findMany` - always exactly two interpolated values,
    // `blockerId` then `blockedId`.
    $queryRaw: jest.fn(async (_strings: unknown, ...values: unknown[]) => {
      const [blockerId, blockedId] = values as [string, string];
      return [blockerId, blockedId]
        .filter((id) => id in carpoolIds)
        .map((userId) => ({ userId, carpoolId: carpoolIds[userId] }));
    }),
    block: {
      upsert: jest.fn(async ({ create }: any) => {
        if (opts?.upsertFails) {
          throw new Error("connection lost");
        }
        blocks.push(create);
        return create;
      }),
    },
  };

  const prisma = Object.defineProperty({ ...client }, "$transaction", {
    value: jest.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
      const savedReports = [...reports];
      const savedBlocks = [...blocks];
      try {
        return await fn(client);
      } catch (error) {
        reports.splice(0, reports.length, ...savedReports);
        blocks.splice(0, blocks.length, ...savedBlocks);
        throw error;
      }
    }),
    enumerable: false,
  });

  return { prisma, reports, blocks };
};

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (
  session: Session | null,
  db = buildReportsDb(),
  // Returned so a test can read what the admin alert handed SES, and
  // overridable so one can make the send fail. Resolves by default.
  sesSend: jest.Mock = jest.fn(async () => ({})),
) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: sesSend },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db, sesSend };
};

const baseInput = {
  reportedUserId: THEM,
  reason: ReportReason.HARASSMENT,
  alsoBlock: false,
};

/** A thread of `count` messages, alternating senders, one minute apart. */
const threadOf = (requestId: string, count: number): MessageRow[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `m-${i}`,
    requestId,
    userId: i % 2 === 0 ? ME : THEM,
    content: `message ${i}`,
    dateCreated: new Date(Date.UTC(2026, 8, 1, 12, i)),
  }));

describe("user.reports.create", () => {
  it("records the session user as the reporter", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    const result = await caller.user.reports.create({
      ...baseInput,
      message: "  They kept messaging after I said no.  ",
    });

    expect(result).toEqual({
      reportId: "report-1",
      blocked: false,
      blockRefusal: null,
    });
    expect(db.reports).toEqual([
      expect.objectContaining({
        reporterId: ME,
        reportedUserId: THEM,
        reason: ReportReason.HARASSMENT,
        message: "They kept messaging after I said no.",
        requestId: null,
        conversationSnapshot: null,
      }),
    ]);
  });

  it("stores a blank message as null", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await caller.user.reports.create({ ...baseInput, message: "   " });

    expect(db.reports[0].message).toBeNull();
  });

  it("refuses an input that tries to name the reporter", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.reports.create({
        ...baseInput,
        reporterId: OTHER,
      } as typeof baseInput),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.reports).toEqual([]);
  });

  it("refuses an anonymous caller", async () => {
    const { caller, db } = callerFor(null);

    await expect(caller.user.reports.create(baseInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.reports).toEqual([]);
  });

  it("refuses a self-report", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.reports.create({ ...baseInput, reportedUserId: ME }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "You can't report yourself.",
    });
    expect(db.reports).toEqual([]);
  });

  it("refuses a user who does not exist", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.reports.create({ ...baseInput, reportedUserId: "ghost" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.reports).toEqual([]);
  });

  it("refuses an unknown reason and an over-long message", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await expect(
      caller.user.reports.create({
        ...baseInput,
        reason: "RUDE" as ReportReason,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.user.reports.create({
        ...baseInput,
        message: "x".repeat(REPORT_MESSAGE_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.reports).toEqual([]);
  });

  it("accepts a message of exactly the cap", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await caller.user.reports.create({
      ...baseInput,
      message: "x".repeat(REPORT_MESSAGE_MAX_LENGTH),
    });

    expect(db.reports[0].message).toHaveLength(REPORT_MESSAGE_MAX_LENGTH);
  });
});

describe("a report made from a conversation", () => {
  const requests = {
    "req-mine": { fromUserId: ME, toUserId: THEM },
    "req-theirs": { fromUserId: THEM, toUserId: ME },
    "req-strangers": { fromUserId: THEM, toUserId: OTHER },
    "req-other": { fromUserId: ME, toUserId: OTHER },
  };

  it.each(["req-mine", "req-theirs"])(
    "keeps a snapshot of the thread, oldest first (%s)",
    async (requestId) => {
      const db = buildReportsDb({
        requests,
        messages: threadOf(requestId, 3),
      });
      const { caller } = callerFor(sessionFor(ME), db);

      await caller.user.reports.create({ ...baseInput, requestId });

      expect(db.reports[0].requestId).toBe(requestId);
      expect(JSON.parse(db.reports[0].conversationSnapshot!)).toEqual([
        {
          senderId: ME,
          content: "message 0",
          sentAt: "2026-09-01T12:00:00.000Z",
        },
        {
          senderId: THEM,
          content: "message 1",
          sentAt: "2026-09-01T12:01:00.000Z",
        },
        {
          senderId: ME,
          content: "message 2",
          sentAt: "2026-09-01T12:02:00.000Z",
        },
      ]);
    },
  );

  it("keeps only the most recent messages, up to the limit", async () => {
    const db = buildReportsDb({
      requests,
      messages: threadOf("req-mine", REPORT_SNAPSHOT_MESSAGE_LIMIT + 5),
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.reports.create({ ...baseInput, requestId: "req-mine" });

    const snapshot = JSON.parse(db.reports[0].conversationSnapshot!);
    expect(snapshot).toHaveLength(REPORT_SNAPSHOT_MESSAGE_LIMIT);
    expect(snapshot[0].content).toBe("message 5");
    expect(snapshot.at(-1).content).toBe(
      `message ${REPORT_SNAPSHOT_MESSAGE_LIMIT + 4}`,
    );
  });

  it("keeps an empty snapshot for a conversation with no messages", async () => {
    const db = buildReportsDb({ requests });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.reports.create({ ...baseInput, requestId: "req-mine" });

    expect(db.reports[0].conversationSnapshot).toBe("[]");
  });

  it("refuses a request the caller is not a party to, before reading any message", async () => {
    const db = buildReportsDb({
      requests,
      messages: threadOf("req-strangers", 3),
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(
      caller.user.reports.create({
        ...baseInput,
        requestId: "req-strangers",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.prisma.message.findMany).not.toHaveBeenCalled();
    expect(db.reports).toEqual([]);
  });

  it("refuses a request whose other party is not the reported user", async () => {
    const db = buildReportsDb({ requests, messages: threadOf("req-other", 3) });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(
      caller.user.reports.create({ ...baseInput, requestId: "req-other" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: REPORT_REQUEST_MISMATCH_MESSAGE,
    });
    expect(db.prisma.message.findMany).not.toHaveBeenCalled();
    expect(db.reports).toEqual([]);
  });

  it("refuses a request that does not exist", async () => {
    const db = buildReportsDb({ requests });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(
      caller.user.reports.create({ ...baseInput, requestId: "req-gone" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.reports).toEqual([]);
  });
});

describe("duplicate reports", () => {
  const priorReport = (status: ReportStatus): ReportRow => ({
    id: "report-prior",
    reporterId: ME,
    reportedUserId: THEM,
    reason: ReportReason.OTHER,
    message: null,
    requestId: null,
    conversationSnapshot: null,
    status,
  });

  it("refuses a second OPEN report about the same person", async () => {
    const db = buildReportsDb({ reports: [priorReport(ReportStatus.OPEN)] });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.reports.create(baseInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: DUPLICATE_REPORT_MESSAGE,
    });
    expect(db.reports).toHaveLength(1);
  });

  it.each([ReportStatus.REVIEWED, ReportStatus.DISMISSED])(
    "accepts a new report once the earlier one is %s",
    async (status) => {
      const db = buildReportsDb({ reports: [priorReport(status)] });
      const { caller } = callerFor(sessionFor(ME), db);

      await caller.user.reports.create(baseInput);

      expect(db.reports).toHaveLength(2);
    },
  );

  it("does not stop a different reporter reporting the same person", async () => {
    const db = buildReportsDb({ reports: [priorReport(ReportStatus.OPEN)] });
    const { caller } = callerFor(sessionFor(OTHER), db);

    await caller.user.reports.create(baseInput);

    expect(db.reports).toHaveLength(2);
  });
});

describe("per-reporter rate limit", () => {
  const reportsFor = (
    reporterId: string,
    count: number,
    dateCreated: Date,
  ): ReportRow[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `report-old-${i}`,
      reporterId,
      reportedUserId: OTHER,
      reason: ReportReason.OTHER,
      message: null,
      requestId: null,
      conversationSnapshot: null,
      status: ReportStatus.DISMISSED,
      dateCreated,
    }));

  const NOW = new Date();
  const OUTSIDE_WINDOW = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  it("refuses the 21st report inside the window, writing nothing", async () => {
    const db = buildReportsDb({ reports: reportsFor(ME, 20, NOW) });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.reports.create(baseInput)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: REPORT_RATE_LIMIT_MESSAGE,
    });

    expect(db.reports).toHaveLength(20);
  });

  it("does not count reports from outside the window", async () => {
    const db = buildReportsDb({
      reports: reportsFor(ME, 20, OUTSIDE_WINDOW),
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.reports.create(baseInput);

    expect(db.reports).toHaveLength(21);
  });

  it("does not count another reporter's reports against this one", async () => {
    const db = buildReportsDb({ reports: reportsFor(OTHER, 20, NOW) });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.reports.create(baseInput);

    expect(db.reports).toHaveLength(21);
  });
});

describe("Also block", () => {
  it("blocks the reported user, with the reporter as the blocker", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    const result = await caller.user.reports.create({
      ...baseInput,
      alsoBlock: true,
    });

    expect(result).toMatchObject({ blocked: true, blockRefusal: null });
    expect(db.blocks).toEqual([{ blockerId: ME, blockedId: THEM }]);
    expect(db.reports).toHaveLength(1);
  });

  it("blocks nobody when it is off", async () => {
    const { caller, db } = callerFor(sessionFor(ME));

    await caller.user.reports.create(baseInput);

    expect(db.prisma.block.upsert).not.toHaveBeenCalled();
    expect(db.blocks).toEqual([]);
  });

  it("still saves the report when the block is refused for a shared group", async () => {
    const db = buildReportsDb({
      carpoolIds: { [ME]: "group-1", [THEM]: "group-1" },
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const result = await caller.user.reports.create({
      ...baseInput,
      alsoBlock: true,
    });

    expect(result).toMatchObject({
      blocked: false,
      blockRefusal: BLOCK_GROUP_MEMBER_MESSAGE,
    });
    expect(db.reports).toHaveLength(1);
    expect(db.blocks).toEqual([]);
  });

  it("saves neither when the block fails for any other reason", async () => {
    const db = buildReportsDb({ upsertFails: true });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(
      caller.user.reports.create({ ...baseInput, alsoBlock: true }),
    ).rejects.toThrow();
    expect(db.reports).toEqual([]);
    expect(db.blocks).toEqual([]);
  });
});

/**
 * `user.reports.me`.
 *
 * The property that matters most is negative and cannot be seen by looking at
 * one caller's list: the rows come from `ctx.session`, never from input, so no
 * caller can reach another reporter's reports. The fake holds rows for two
 * reporters in most of these, and the cross-user case is also asserted against
 * a real database in `reports.db.test.ts`.
 */
describe("user.reports.me", () => {
  /** A row for the fake, with the fields `me` reads. */
  const reportRow = (
    id: string,
    reporterId: string,
    reportedUserId: string,
    overrides: Partial<ReportRow> = {},
  ): ReportRow => ({
    id,
    reporterId,
    reportedUserId,
    reason: ReportReason.HARASSMENT,
    message: null,
    requestId: null,
    conversationSnapshot: null,
    status: ReportStatus.OPEN,
    dateCreated: new Date(Date.UTC(2026, 0, 1)),
    ...overrides,
  });

  it("returns only the caller's own reports, newest first", async () => {
    const db = buildReportsDb({
      reports: [
        reportRow("r-1", ME, THEM, {
          dateCreated: new Date(Date.UTC(2026, 0, 1)),
        }),
        reportRow("r-2", ME, OTHER, {
          dateCreated: new Date(Date.UTC(2026, 0, 3)),
          reason: ReportReason.NO_SHOW,
        }),
        // Someone else's report, about the caller. Listing this would tell a
        // reported user that they had been reported.
        reportRow("r-3", OTHER, ME, {
          dateCreated: new Date(Date.UTC(2026, 0, 5)),
        }),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const list = await caller.user.reports.me();

    expect(list.map((row) => row.id)).toEqual(["r-2", "r-1"]);
    expect(db.prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { reporterId: ME } }),
    );
  });

  it("derives the reporter from the session, not from anything a caller sends", async () => {
    const db = buildReportsDb({ reports: [reportRow("r-1", OTHER, THEM)] });
    const { caller } = callerFor(sessionFor(ME), db);

    // `me` takes no input at all, so the only way to ask for someone else's
    // rows would be a procedure that read one. This is the assertion that
    // adding such an input would have to break.
    await expect(caller.user.reports.me()).resolves.toEqual([]);
  });

  it("refuses a caller with no session", async () => {
    const { caller } = callerFor(null);

    await expect(caller.user.reports.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("carries the reason, status, dates and the reporter's own words", async () => {
    const db = buildReportsDb({
      reports: [
        reportRow("r-1", ME, THEM, {
          reason: ReportReason.SAFETY_CONCERN,
          message: "They drove off while I was still getting in.",
          status: ReportStatus.REVIEWED,
          dateCreated: new Date(Date.UTC(2026, 0, 1)),
          dateModified: new Date(Date.UTC(2026, 0, 9)),
        }),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    expect(await caller.user.reports.me()).toEqual([
      {
        id: "r-1",
        reportedName: "Them",
        reason: ReportReason.SAFETY_CONCERN,
        message: "They drove off while I was still getting in.",
        status: ReportStatus.REVIEWED,
        filedAt: new Date(Date.UTC(2026, 0, 1)),
        updatedAt: new Date(Date.UTC(2026, 0, 9)),
      },
    ]);
  });

  /*
   * The whole of what a row says about the reported person is their display
   * name. The conversation snapshot in particular is the other party's words
   * as well as the reporter's, and it is kept for admins to read, not to be
   * handed back.
   */
  it("says nothing about the reported user beyond the display name", async () => {
    const db = buildReportsDb({
      reports: [
        reportRow("r-1", ME, THEM, {
          requestId: "request-1",
          conversationSnapshot: '[{"senderId":"user-them","content":"no"}]',
        }),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const [row] = await caller.user.reports.me();

    expect(Object.keys(row).sort()).toEqual([
      "filedAt",
      "id",
      "message",
      "reason",
      "reportedName",
      "status",
      "updatedAt",
    ]);
  });

  it("falls back from preferred name to account name to Unknown user", async () => {
    const db = buildReportsDb({
      reports: [
        reportRow("r-1", ME, THEM, {
          dateCreated: new Date(Date.UTC(2026, 0, 3)),
        }),
        reportRow("r-2", ME, OTHER, {
          dateCreated: new Date(Date.UTC(2026, 0, 2)),
        }),
        reportRow("r-3", ME, NAMELESS, {
          dateCreated: new Date(Date.UTC(2026, 0, 1)),
        }),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const names = (await caller.user.reports.me()).map(
      (row) => row.reportedName,
    );

    // `THEM` has a preferred name, `OTHER` only an account name, `NAMELESS`
    // neither.
    expect(names).toEqual(["Them", "Other Full", "Unknown user"]);
  });

  it("breaks a same-instant tie on id rather than leaving the order open", async () => {
    const sameMoment = new Date(Date.UTC(2026, 0, 4));
    const db = buildReportsDb({
      reports: [
        reportRow("r-a", ME, THEM, { dateCreated: sameMoment }),
        reportRow("r-b", ME, OTHER, { dateCreated: sameMoment }),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    expect((await caller.user.reports.me()).map((row) => row.id)).toEqual([
      "r-b",
      "r-a",
    ]);
    expect(db.prisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
      }),
    );
  });
});

/**
 * The refusal of a second OPEN report has to name somewhere the reporter can
 * actually go, which is the heading `ReportsFiledSection` renders. A rename on
 * either side fails here.
 */
describe("DUPLICATE_REPORT_MESSAGE", () => {
  it("points at the profile section that now lists the first report", () => {
    expect(DUPLICATE_REPORT_MESSAGE).toContain("Reports You've Filed");
    expect(DUPLICATE_REPORT_MESSAGE).toContain("profile");
  });
});

/**
 * The admin alert `create` fires once the report is written.
 *
 * The module's own behaviour — recipients, the cap, the budget exemption — is
 * in `src/server/adminReportAlert.test.ts`. What belongs here is the join: that
 * filing a report sends it at all, that no word of the report travels with it,
 * and that a send which fails leaves the report in place.
 */
describe("user.reports.create fires the admin alert", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("mails the admins without anyone opening /admin", async () => {
    const { caller, sesSend } = callerFor(sessionFor(ME));

    await caller.user.reports.create(baseInput);

    expect(sesSend).toHaveBeenCalledTimes(1);
    const sent = sesSend.mock.calls[0][0].input;
    expect(sent.Template).toBe("AdminReportTemplate");
    expect(sent.Destination.ToAddresses).toEqual([ADMIN_EMAIL]);
  });

  /**
   * The acceptance criterion this feature most needs to keep. Both
   * user-authored fields are given distinctive text and the whole serialised
   * command is searched for it — not just `TemplateData`, because an address
   * or a subject built from a report would be just as much of a disclosure.
   */
  it("carries neither the reporter's message nor the snapshot", async () => {
    const db = buildReportsDb({
      requests: { "req-1": { fromUserId: ME, toUserId: THEM } },
      messages: threadOf("req-1", 3),
    });
    const { caller, sesSend } = callerFor(sessionFor(ME), db);

    await caller.user.reports.create({
      ...baseInput,
      message: "UNIQUE-REPORTER-PROSE",
      requestId: "req-1",
    });

    // The fixture really did store both, so the assertion below is about the
    // email and not about an empty report.
    expect(db.reports[0].message).toBe("UNIQUE-REPORTER-PROSE");
    expect(db.reports[0].conversationSnapshot).toContain("message 0");

    const serialised = JSON.stringify(sesSend.mock.calls[0][0].input);
    expect(serialised).not.toContain("UNIQUE-REPORTER-PROSE");
    expect(serialised).not.toContain("message 0");
    // Nor either party's identity.
    expect(serialised).not.toContain(ME);
    expect(serialised).not.toContain(THEM);
  });

  it("names the reason, so a safety concern is triageable from the subject", async () => {
    const { caller, sesSend } = callerFor(sessionFor(ME));

    await caller.user.reports.create({
      ...baseInput,
      reason: ReportReason.SAFETY_CONCERN,
    });

    const data = JSON.parse(sesSend.mock.calls[0][0].input.TemplateData);
    expect(data.reasonPlain).toBe("Safety concern");
  });

  it("still writes the report when the send throws", async () => {
    const db = buildReportsDb();
    const { caller } = callerFor(
      sessionFor(ME),
      db,
      jest.fn(async () => {
        throw new Error("TemplateDoesNotExist");
      }),
    );

    // Resolves, and with the ordinary payload: the reporter is told nothing
    // about an admin mailbox being unreachable.
    await expect(caller.user.reports.create(baseInput)).resolves.toEqual({
      reportId: "report-1",
      blocked: false,
      blockRefusal: null,
    });
    expect(db.reports).toHaveLength(1);
  });

  it("still writes the report when the admin roster cannot be read", async () => {
    const db = buildReportsDb();
    db.prisma.user.findMany.mockRejectedValueOnce(new Error("connection lost"));
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.reports.create(baseInput)).resolves.toEqual({
      reportId: "report-1",
      blocked: false,
      blockRefusal: null,
    });
    expect(db.reports).toHaveLength(1);
  });

  /**
   * A refusal must not mail anyone. The alert runs after the transaction, so
   * anything that throws before it — here the duplicate-report guard — should
   * leave SES untouched.
   */
  it("sends nothing when the report itself is refused", async () => {
    const db = buildReportsDb({
      reports: [
        {
          id: "report-existing",
          reporterId: ME,
          reportedUserId: THEM,
          reason: ReportReason.HARASSMENT,
          message: null,
          requestId: null,
          conversationSnapshot: null,
          status: ReportStatus.OPEN,
        },
      ],
    });
    const { caller, sesSend } = callerFor(sessionFor(ME), db);

    await expect(caller.user.reports.create(baseInput)).rejects.toThrow(
      DUPLICATE_REPORT_MESSAGE,
    );
    expect(sesSend).not.toHaveBeenCalled();
  });
});
