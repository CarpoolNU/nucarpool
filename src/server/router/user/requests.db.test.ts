import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";
import { BLOCKED_PAIR_MESSAGE } from "../../db/blocks";

/**
 * `user.requests.delete` against a real MySQL (SCRUM-562).
 *
 * The property worth a real database: once a block exists between the two
 * parties, `delete` must refuse rather than take the conversation and every
 * message with it - otherwise the blocked party can destroy the evidence a
 * `reports.create` snapshot depends on before the blocker files it. The
 * mocked suite (`requests.test.ts`) already covers the refusal against a
 * fake `block` table; this is the same behaviour against real cascades and a
 * real transaction, where a bug in the emulated relation could otherwise let
 * the delete through underneath the check.
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

/** Two users, a request between them, and a conversation with one message. */
const seedConversation = async () => {
  const blocker = await prisma.user.create({
    data: { name: "Blocker", email: "blocker@northeastern.edu" },
  });
  const blocked = await prisma.user.create({
    data: { name: "Blocked", email: "blocked@northeastern.edu" },
  });

  const request = await prisma.request.create({
    data: { message: "", fromUserId: blocked.id, toUserId: blocker.id },
  });
  const conversation = await prisma.conversation.create({
    data: { requestId: request.id },
  });
  await prisma.request.update({
    where: { id: request.id },
    data: { conversationId: conversation.id },
  });
  await prisma.message.create({
    data: {
      content: "hey",
      userId: blocked.id,
      conversationId: conversation.id,
    },
  });

  return { blocker, blocked, request };
};

describe("user.requests.delete across a block, against a real database", () => {
  it("refuses the blocked party, leaving the thread for a later report", async () => {
    const { blocker, blocked, request } = await seedConversation();
    await prisma.block.create({
      data: { blockerId: blocker.id, blockedId: blocked.id },
    });

    await expect(
      callerFor(blocked.id).user.requests.delete({
        invitationId: request.id,
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: BLOCKED_PAIR_MESSAGE,
    });

    expect(await prisma.request.count()).toBe(1);
    expect(await prisma.message.count()).toBe(1);
  });

  it("refuses the blocker too, since either direction hides the same row", async () => {
    const { blocker, blocked, request } = await seedConversation();
    await prisma.block.create({
      data: { blockerId: blocker.id, blockedId: blocked.id },
    });

    await expect(
      callerFor(blocker.id).user.requests.delete({
        invitationId: request.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await prisma.request.count()).toBe(1);
  });

  it("still allows the delete once the block is lifted", async () => {
    const { blocker, blocked, request } = await seedConversation();
    const block = await prisma.block.create({
      data: { blockerId: blocker.id, blockedId: blocked.id },
    });
    await prisma.block.delete({ where: { id: block.id } });

    await callerFor(blocked.id).user.requests.delete({
      invitationId: request.id,
    });

    expect(await prisma.request.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });
});
