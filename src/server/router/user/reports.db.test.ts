import { Permission, ReportReason, ReportStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";
import { parseConversationSnapshot } from "../../reportSnapshot";

/**
 * `user.reports.create` against a real MySQL.
 *
 * The property worth a real database is the one the snapshot exists for:
 * either party can delete the request, and `requests.delete` takes the
 * conversation and every message with it. The report must still hold the
 * thread afterwards. The mocked suite cannot show that, because its fake
 * `requests.delete` would delete only what the test told it to.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

const sessionFor = (
  id: string,
  permission: Permission = Permission.USER,
): Session => ({
  expires: new Date(Date.now() + 60_000).toISOString(),
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission,
  },
});

const callerFor = (userId: string, permission: Permission = Permission.USER) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId, permission),
    prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

/** Two users, a request between them, and a three-message thread. */
const seedConversation = async () => {
  const reporter = await prisma.user.create({
    data: { name: "Reporter", email: "reporter@northeastern.edu" },
  });
  const reported = await prisma.user.create({
    data: { name: "Reported", email: "reported@northeastern.edu" },
  });

  const request = await prisma.request.create({
    data: { message: "", fromUserId: reported.id, toUserId: reporter.id },
  });
  const conversation = await prisma.conversation.create({
    data: { requestId: request.id },
  });
  await prisma.request.update({
    where: { id: request.id },
    data: { conversationId: conversation.id },
  });

  const thread = [
    { userId: reported.id, content: "hey" },
    { userId: reporter.id, content: "please stop messaging me" },
    { userId: reported.id, content: "no" },
  ];
  for (const [i, message] of thread.entries()) {
    await prisma.message.create({
      data: {
        ...message,
        conversationId: conversation.id,
        dateCreated: new Date(Date.UTC(2026, 8, 1, 12, i)),
      },
    });
  }

  return { reporter, reported, request };
};

describe("a report made from a conversation, against a real database", () => {
  it("keeps its snapshot after the reported user deletes the request", async () => {
    const { reporter, reported, request } = await seedConversation();

    const { reportId } = await callerFor(reporter.id).user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.HARASSMENT,
      requestId: request.id,
      alsoBlock: false,
    });

    // The case the snapshot exists for: the person reported clears the
    // thread, which takes the conversation and its messages with it.
    await callerFor(reported.id).user.requests.delete({
      invitationId: request.id,
    });

    expect(await prisma.request.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);

    const report = await prisma.report.findUniqueOrThrow({
      where: { id: reportId },
    });
    expect(report).toMatchObject({
      reporterId: reporter.id,
      reportedUserId: reported.id,
      requestId: request.id,
      status: ReportStatus.OPEN,
    });
    expect(
      parseConversationSnapshot(report.conversationSnapshot)?.map(
        ({ senderId, content }) => ({ senderId, content }),
      ),
    ).toEqual([
      { senderId: reported.id, content: "hey" },
      { senderId: reporter.id, content: "please stop messaging me" },
      { senderId: reported.id, content: "no" },
    ]);
  });

  it("writes the report and the block together when Also block is on", async () => {
    const { reporter, reported, request } = await seedConversation();

    const result = await callerFor(reporter.id).user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.SAFETY_CONCERN,
      requestId: request.id,
      alsoBlock: true,
    });

    expect(result).toMatchObject({ blocked: true, blockRefusal: null });
    expect(await prisma.report.count()).toBe(1);
    expect(
      await prisma.block.findMany({
        select: { blockerId: true, blockedId: true },
      }),
    ).toEqual([{ blockerId: reporter.id, blockedId: reported.id }]);
  });

  it("refuses a second OPEN report, leaving one row", async () => {
    const { reporter, reported } = await seedConversation();
    const report = () =>
      callerFor(reporter.id).user.reports.create({
        reportedUserId: reported.id,
        reason: ReportReason.OTHER,
        alsoBlock: false,
      });

    await report();
    await expect(report()).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await prisma.report.count()).toBe(1);
  });
});

/**
 * `user.reports.me` against a real database.
 *
 * The scoping is what earns a real MySQL here. A fake answers whatever its
 * `findMany` was written to answer, so "A cannot read B's reports" against one
 * tests the fake; against real rows it tests the `where` clause. Three
 * reporters' rows are present in each of these, and only one caller's come
 * back.
 */
describe("the reports a user has filed, against a real database", () => {
  /** Three users, so a list can be wrong in both directions. */
  const seedThree = async () => {
    const [alex, blair, casey] = await Promise.all(
      ["alex", "blair", "casey"].map((who) =>
        prisma.user.create({
          data: { name: who, email: `${who}@northeastern.edu` },
        }),
      ),
    );
    return { alex, blair, casey };
  };

  it("returns the caller's own rows and never another reporter's", async () => {
    const { alex, blair, casey } = await seedThree();

    await callerFor(alex.id).user.reports.create({
      reportedUserId: casey.id,
      reason: ReportReason.NO_SHOW,
      message: "Alex's words",
      alsoBlock: false,
    });
    await callerFor(blair.id).user.reports.create({
      reportedUserId: casey.id,
      reason: ReportReason.HARASSMENT,
      message: "Blair's words",
      alsoBlock: false,
    });
    // Blair reports Alex too, so Alex is a reported user as well as a
    // reporter. A list keyed on the wrong column would surface this one.
    await callerFor(blair.id).user.reports.create({
      reportedUserId: alex.id,
      reason: ReportReason.FAKE_PROFILE,
      alsoBlock: false,
    });

    expect(await prisma.report.count()).toBe(3);

    const mine = await callerFor(alex.id).user.reports.me();

    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      reportedName: "casey",
      reason: ReportReason.NO_SHOW,
      message: "Alex's words",
      status: ReportStatus.OPEN,
    });
  });

  it("shows the reporter a resolution an admin made, with no other change", async () => {
    const { alex, blair, casey } = await seedThree();

    const { reportId } = await callerFor(alex.id).user.reports.create({
      reportedUserId: casey.id,
      reason: ReportReason.SAFETY_CONCERN,
      alsoBlock: false,
    });

    const [beforeResolution] = await callerFor(alex.id).user.reports.me();
    expect(beforeResolution.status).toBe(ReportStatus.OPEN);

    await callerFor(blair.id, Permission.ADMIN).user.admin.resolveReport({
      reportId,
      status: ReportStatus.REVIEWED,
    });

    const [afterResolution] = await callerFor(alex.id).user.reports.me();

    expect(afterResolution.status).toBe(ReportStatus.REVIEWED);
    expect(afterResolution.id).toBe(reportId);

    /*
     * The two dates are the two columns, the right way round. The client
     * renders `updatedAt` as when the decision was made, which is only sound
     * while `resolveReport` is the one thing that writes a report after it is
     * created — so a swap of these two, or a `filedAt` quietly sourced from
     * `dateModified`, would put a resolution date under "Filed".
     *
     * Asserted as equality against the stored row rather than as "later than
     * the filing": `DATETIME(3)` means a fast test can resolve a report
     * inside the same millisecond it was filed, and an ordering assertion
     * would be a coin flip there.
     */
    const stored = await prisma.report.findUniqueOrThrow({
      where: { id: reportId },
    });
    expect(afterResolution.filedAt).toEqual(stored.dateCreated);
    expect(afterResolution.updatedAt).toEqual(stored.dateModified);
  });
});

/**
 * The admin alert must never cost the report.
 *
 * `reports.test.ts` asserts this against a fake whose `$transaction` restores
 * two in-memory arrays on a throw, which is a model of a rollback rather than
 * one. The property worth a real MySQL is that the row is **committed** and
 * still there after the send has failed — if the alert were inside the
 * transaction, or its rejection reached the mutation, this is where that
 * would show.
 */
describe("a failing admin alert against a real database", () => {
  /**
   * Returns the send mock alongside the caller so each test can assert the
   * throw actually happened. Without that, a run where the alert stopped
   * earlier — no admin seeded, or `NEXT_PUBLIC_ENV=staging` filtering a
   * northeastern.edu roster out — would pass these tests having never failed
   * a send at all.
   */
  const failingSesCaller = (userId: string) => {
    const send = jest.fn(async () => {
      // What SES answers until someone runs
      // `scripts/emailtemplate.py --apply` to publish AdminReportTemplate,
      // which is the state this ships in.
      throw new Error("TemplateDoesNotExist");
    });

    return {
      send,
      caller: appRouter.createCaller({
        req: undefined,
        res: undefined,
        session: sessionFor(userId),
        prisma,
        sesClient: { send },
      } as unknown as Context),
    };
  };

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("commits the report even though the send threw", async () => {
    const reporter = await prisma.user.create({
      data: { name: "Reporter", email: "reporter@northeastern.edu" },
    });
    const reported = await prisma.user.create({
      data: { name: "Reported", email: "reported@northeastern.edu" },
    });
    // An admin, so the alert gets as far as the send rather than stopping at
    // "no recipients" — otherwise this would pass without a throw happening.
    await prisma.user.create({
      data: {
        name: "Admin",
        email: "admin@northeastern.edu",
        permission: Permission.ADMIN,
      },
    });

    const { caller, send } = failingSesCaller(reporter.id);
    const { reportId } = await caller.user.reports.create({
      reportedUserId: reported.id,
      reason: ReportReason.SAFETY_CONCERN,
      message: "they followed me to my car",
      alsoBlock: false,
    });

    // The premise: a send was attempted and it threw. Without this the test
    // would pass on a run where the alert never reached SES.
    expect(send).toHaveBeenCalledTimes(1);

    // Read back on a fresh query, not from the mutation's return value: the
    // question is whether it committed.
    const stored = await prisma.report.findUniqueOrThrow({
      where: { id: reportId },
    });
    expect(stored).toMatchObject({
      reporterId: reporter.id,
      reportedUserId: reported.id,
      reason: ReportReason.SAFETY_CONCERN,
      status: ReportStatus.OPEN,
      message: "they followed me to my car",
    });
    expect(await prisma.report.count()).toBe(1);
  });

  it("still applies an accompanying block when the send throws", async () => {
    const reporter = await prisma.user.create({
      data: { name: "Reporter B", email: "reporter-b@northeastern.edu" },
    });
    const reported = await prisma.user.create({
      data: { name: "Reported B", email: "reported-b@northeastern.edu" },
    });
    await prisma.user.create({
      data: {
        name: "Admin B",
        email: "admin-b@northeastern.edu",
        permission: Permission.ADMIN,
      },
    });

    const { caller, send } = failingSesCaller(reporter.id);
    const result = await caller.user.reports.create({
      reportedUserId: reported.id,
      // `SAFETY_CONCERN` rather than `HARASSMENT`, which this used before
      // SCRUM-625. Only a reason `REPORT_URGENCY` marks `IMMEDIATE` sends mail
      // on filing now, so a digest reason here would reach the assertion below
      // having attempted no send at all — and the point of this test is that a
      // send which *throws* does not take the block with it.
      reason: ReportReason.SAFETY_CONCERN,
      alsoBlock: true,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result.blocked).toBe(true);
    expect(
      await prisma.block.findFirst({
        where: { blockerId: reporter.id, blockedId: reported.id },
      }),
    ).not.toBeNull();
  });
});
