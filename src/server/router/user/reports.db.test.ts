import { Permission, ReportReason, ReportStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";
import { parseConversationSnapshot } from "../../reportSnapshot";

/**
 * `user.reports.create` against a real MySQL (SCRUM-555).
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

const sessionFor = (id: string): Session => ({
  expires: new Date(Date.now() + 60_000).toISOString(),
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (userId: string) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
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
