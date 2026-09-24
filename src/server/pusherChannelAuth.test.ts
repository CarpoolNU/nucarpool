import { canSubscribe } from "./pusherChannelAuth";
import {
  conversationChannel,
  notificationChannel,
  parseChannel,
} from "../utils/pusherChannels";
import { fakeBlockDelegate } from "../testing/blockFake";
import type { BlockRow } from "../testing/blockFake";

/**
 * Realtime access control.
 *
 * Before this, both Pusher channels were public and named after ids other
 * users can already see — `user.requests.me` hands out request ids, every
 * `PublicUser` carries a user id — while `NEXT_PUBLIC_PUSHER_KEY` ships in the
 * browser bundle. Anyone could subscribe to a stranger's conversation or
 * notification feed and read message content live, without ever calling the
 * API.
 *
 * `canSubscribe` is the whole of the fix's decision logic, so it is tested
 * directly rather than through an HTTP harness. Nothing here touches Pusher.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const MALLORY = "user-mallory";
const REQUEST_ID = "request-1";

const prismaWith = (
  request: { fromUserId: string; toUserId: string } | null = {
    fromUserId: ALICE,
    toUserId: BOB,
  },
  blocks: BlockRow[] = [],
) => ({
  block: fakeBlockDelegate(blocks),
  request: {
    findUnique: jest.fn(async ({ where }: any) =>
      request && where.id === REQUEST_ID ? { ...request } : null,
    ),
  },
});

describe("canSubscribe — notification channels", () => {
  it("admits a user to their own notification feed", async () => {
    const prisma = prismaWith();

    await expect(
      canSubscribe(prisma as any, ALICE, notificationChannel(ALICE)),
    ).resolves.toBe(true);
  });

  it("refuses a user another user's notification feed", async () => {
    // The headline attack: knowing a user id was enough to read their messages.
    const prisma = prismaWith();

    await expect(
      canSubscribe(prisma as any, MALLORY, notificationChannel(ALICE)),
    ).resolves.toBe(false);
  });

  it("does not hit the database to answer a notification channel", async () => {
    const prisma = prismaWith();

    await canSubscribe(prisma as any, ALICE, notificationChannel(ALICE));

    expect(prisma.request.findUnique).not.toHaveBeenCalled();
  });
});

describe("canSubscribe — conversation channels", () => {
  it("admits the request's sender", async () => {
    await expect(
      canSubscribe(prismaWith() as any, ALICE, conversationChannel(REQUEST_ID)),
    ).resolves.toBe(true);
  });

  it("admits the request's recipient", async () => {
    await expect(
      canSubscribe(prismaWith() as any, BOB, conversationChannel(REQUEST_ID)),
    ).resolves.toBe(true);
  });

  it("refuses a third party", async () => {
    await expect(
      canSubscribe(
        prismaWith() as any,
        MALLORY,
        conversationChannel(REQUEST_ID),
      ),
    ).resolves.toBe(false);
  });

  it("refuses a conversation whose request does not exist", async () => {
    await expect(
      canSubscribe(prismaWith(null) as any, ALICE, conversationChannel("nope")),
    ).resolves.toBe(false);
  });
});

describe("canSubscribe — a blocked pair's conversation channel (SCRUM-554)", () => {
  // `messages.conversation` refuses a blocked pair's thread, so its realtime
  // channel must close too, or new messages would still arrive live. Every
  // combination of who blocked whom and who is subscribing.
  const cases: [string, BlockRow, string][] = [
    ["the sender, who blocked", { blockerId: ALICE, blockedId: BOB }, ALICE],
    [
      "the recipient, who was blocked",
      { blockerId: ALICE, blockedId: BOB },
      BOB,
    ],
    ["the recipient, who blocked", { blockerId: BOB, blockedId: ALICE }, BOB],
    [
      "the sender, who was blocked",
      { blockerId: BOB, blockedId: ALICE },
      ALICE,
    ],
  ];

  it.each(cases)("refuses %s", async (_label, block, userId) => {
    const prisma = prismaWith(undefined, [block]);

    await expect(
      canSubscribe(prisma as any, userId, conversationChannel(REQUEST_ID)),
    ).resolves.toBe(false);
  });

  it("still admits both parties when the only block is with somebody else", async () => {
    // Control: Alice's block on a third party says nothing about Bob.
    const prisma = prismaWith(undefined, [
      { blockerId: ALICE, blockedId: MALLORY },
    ]);

    for (const userId of [ALICE, BOB]) {
      await expect(
        canSubscribe(prisma as any, userId, conversationChannel(REQUEST_ID)),
      ).resolves.toBe(true);
    }
  });

  it("admits the pair again once the block is removed", async () => {
    const prisma = prismaWith(undefined, [
      { blockerId: BOB, blockedId: ALICE },
    ]);

    await expect(
      canSubscribe(prisma as any, ALICE, conversationChannel(REQUEST_ID)),
    ).resolves.toBe(false);

    prisma.block.rows.splice(0, prisma.block.rows.length);

    await expect(
      canSubscribe(prisma as any, ALICE, conversationChannel(REQUEST_ID)),
    ).resolves.toBe(true);
  });

  it("leaves each party's own notification feed alone", async () => {
    // The feed carries every thread, not this one, so a block does not close it.
    const prisma = prismaWith(undefined, [
      { blockerId: ALICE, blockedId: BOB },
    ]);

    for (const userId of [ALICE, BOB]) {
      await expect(
        canSubscribe(prisma as any, userId, notificationChannel(userId)),
      ).resolves.toBe(true);
    }
    expect(prisma.block.findFirst).not.toHaveBeenCalled();
  });

  it("still refuses an outsider, who is turned away before any block is read", async () => {
    // Mallory is blocked by nobody; the participant check alone refuses her.
    const prisma = prismaWith(undefined, [
      { blockerId: ALICE, blockedId: BOB },
    ]);

    await expect(
      canSubscribe(prisma as any, MALLORY, conversationChannel(REQUEST_ID)),
    ).resolves.toBe(false);
    expect(prisma.block.findFirst).not.toHaveBeenCalled();
  });
});

describe("canSubscribe — denies by default", () => {
  // Anything that is not a shape we recognise must fail closed, so adding a
  // channel without adding a rule cannot accidentally be world-readable.
  const cases: [string, string][] = [
    ["a public conversation channel", `conversation-${REQUEST_ID}`],
    ["a public notification channel", `notification-${ALICE}`],
    ["an unknown private channel", "private-something-else"],
    ["a presence channel", `presence-conversation-${REQUEST_ID}`],
    ["a private channel with no id", "private-notification-"],
    ["an empty channel name", ""],
    [
      "a name that merely contains the prefix",
      `x-private-notification-${ALICE}`,
    ],
  ];

  it.each(cases)("refuses %s", async (_label, channelName) => {
    await expect(
      canSubscribe(prismaWith() as any, ALICE, channelName),
    ).resolves.toBe(false);
  });

  it("refuses a channel whose id merely starts with the caller's id", async () => {
    // `private-notification-user-alice-evil` must not match user-alice.
    await expect(
      canSubscribe(
        prismaWith() as any,
        ALICE,
        `private-notification-${ALICE}-evil`,
      ),
    ).resolves.toBe(false);
  });
});

describe("channel names round-trip", () => {
  // The builders and the parser are the two halves of the same contract; a
  // mismatch between them is exactly how this check would get bypassed.
  it("parses a conversation channel back to its request id", () => {
    expect(parseChannel(conversationChannel(REQUEST_ID))).toEqual({
      kind: "conversation",
      requestId: REQUEST_ID,
    });
  });

  it("parses a notification channel back to its user id", () => {
    expect(parseChannel(notificationChannel(ALICE))).toEqual({
      kind: "notification",
      userId: ALICE,
    });
  });

  it("marks both builders as private channels", () => {
    expect(conversationChannel(REQUEST_ID)).toMatch(/^private-/);
    expect(notificationChannel(ALICE)).toMatch(/^private-/);
  });
});
