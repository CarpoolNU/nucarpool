import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import type { Context } from "../context";

/**
 * Correctness tests for `user.messages.sendMessage` (SCRUM-230).
 *
 * Two defects sat in ~50 lines:
 *
 *  1. The push notification always went to `request.toUserId`, so a reply from
 *     the request's recipient was delivered to that person's own channel and
 *     the original sender was never notified. Half of every conversation got
 *     no live notification.
 *  2. The message was only written inside `if (conversation)`. When no
 *     conversation row existed the handler created and linked one, wrote no
 *     message, and resolved successfully — the user's text was lost.
 *
 * `pusher` is mocked at the module boundary, so this suite cannot emit a real
 * Pusher event. That matters: `sendMessage` fires on live channels in normal
 * operation, and nothing here may reach them.
 */

const mockTrigger = jest.fn(async () => ({}) as any);

jest.mock("pusher", () => ({
  __esModule: true,
  default: jest.fn(() => ({ trigger: mockTrigger })),
}));

// `jest.mock` is hoisted above imports, so the router below picks up the mock.
import { appRouter } from "../index";

const SENDER = "user-from";
const RECIPIENT = "user-to";
const OUTSIDER = "user-outsider";
const REQUEST_ID = "request-1";
const CONVERSATION_ID = "conversation-1";

type ConversationRow = { id: string; requestId: string };

const buildMessageDb = (opts?: {
  request?: { id: string; fromUserId: string; toUserId: string } | null;
  conversation?: ConversationRow | null;
}) => {
  const request =
    opts?.request === undefined
      ? { id: REQUEST_ID, fromUserId: SENDER, toUserId: RECIPIENT }
      : opts?.request;

  let conversation =
    opts?.conversation === undefined
      ? { id: CONVERSATION_ID, requestId: REQUEST_ID }
      : opts?.conversation;

  const messages: {
    id: string;
    conversationId: string;
    content: string;
    userId: string;
  }[] = [];

  let linkedConversationId: string | null = conversation?.id ?? null;

  const prisma = {
    request: {
      findUnique: jest.fn(async ({ where }: any) =>
        request && request.id === where.id ? { ...request } : null,
      ),
      update: jest.fn(async ({ data }: any) => {
        linkedConversationId = data.conversationId;
        return { ...request, conversationId: data.conversationId };
      }),
    },
    conversation: {
      findUnique: jest.fn(async ({ where }: any) =>
        conversation && conversation.requestId === where.requestId
          ? { ...conversation }
          : null,
      ),
      create: jest.fn(async ({ data }: any) => {
        conversation = {
          id: "conversation-created",
          requestId: data.requestId,
        };
        return { ...conversation };
      }),
    },
    message: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `message-${messages.length + 1}`, ...data };
        messages.push(row);
        return row;
      }),
    },
  };

  return {
    prisma,
    messages: () => [...messages],
    conversationId: () => conversation?.id ?? null,
    linkedConversationId: () => linkedConversationId,
  };
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

const callerFor = (session: Session | null, db = buildMessageDb()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;
  return { caller: appRouter.createCaller(ctx), db };
};

/** Channel names passed to pusher.trigger, in call order. */
const triggeredChannels = () => mockTrigger.mock.calls.map((c: any[]) => c[0]);

const notificationChannels = () =>
  triggeredChannels().filter((c: string) => c.startsWith("notification-"));

beforeEach(() => {
  mockTrigger.mockClear();
});

describe("sendMessage — the notification goes to the other party", () => {
  it("notifies the request's recipient when the request's sender writes", async () => {
    const { caller } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(notificationChannels()).toEqual([`notification-${RECIPIENT}`]);
  });

  it("notifies the request's sender when the recipient replies", async () => {
    // The defect: this used to address `toUserId` — the replier's own channel —
    // so the original sender never saw the badge increment.
    const { caller } = callerFor(sessionFor(RECIPIENT));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "replying",
    });

    expect(notificationChannels()).toEqual([`notification-${SENDER}`]);
  });

  it("never notifies the author of the message", async () => {
    for (const author of [SENDER, RECIPIENT]) {
      mockTrigger.mockClear();
      const { caller } = callerFor(sessionFor(author));

      await caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "x",
      });

      expect(notificationChannels()).not.toContain(`notification-${author}`);
    }
  });

  it("always broadcasts on the conversation channel as well", async () => {
    const { caller } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(triggeredChannels()).toContain(`conversation-${REQUEST_ID}`);
  });
});

describe("sendMessage — the message is always persisted", () => {
  it("writes the message when the conversation already exists", async () => {
    const { caller, db } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(db.messages()).toEqual([
      expect.objectContaining({
        content: "hello",
        userId: SENDER,
        conversationId: CONVERSATION_ID,
      }),
    ]);
  });

  it("writes the message when no conversation existed yet", async () => {
    // The defect: the handler created and linked the conversation, then
    // returned success without ever writing the message.
    const db = buildMessageDb({ conversation: null });
    const { caller } = callerFor(sessionFor(SENDER), db);

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "first message",
    });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: "first message", userId: SENDER }),
    ]);
    expect(db.prisma.conversation.create).toHaveBeenCalledTimes(1);
  });

  it("links the newly created conversation to the request", async () => {
    const db = buildMessageDb({ conversation: null });
    const { caller } = callerFor(sessionFor(SENDER), db);

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "first message",
    });

    expect(db.linkedConversationId()).toBe(db.conversationId());
  });

  it("still notifies the right party on the first message of a thread", async () => {
    const db = buildMessageDb({ conversation: null });
    const { caller } = callerFor(sessionFor(RECIPIENT), db);

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "first message",
    });

    expect(notificationChannels()).toEqual([`notification-${SENDER}`]);
  });

  it("returns the created message so the client can tell it landed", async () => {
    const { caller } = callerFor(sessionFor(SENDER));

    const result = await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(result).toEqual(
      expect.objectContaining({ content: "hello", userId: SENDER }),
    );
  });
});

describe("sendMessage — real-time failures do not lose the message", () => {
  it("still succeeds and persists when Pusher rejects", async () => {
    // The message row is the source of truth; failing the mutation here would
    // tell the user their message was lost and invite a duplicate.
    mockTrigger.mockRejectedValueOnce(new Error("pusher is down"));
    const { caller, db } = callerFor(sessionFor(SENDER));

    const result = await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(result).toEqual(expect.objectContaining({ content: "hello" }));
    expect(db.messages()).toHaveLength(1);
  });
});

describe("sendMessage — guards", () => {
  it("reports NOT_FOUND for a request that does not exist", async () => {
    const db = buildMessageDb({ request: null });
    const { caller } = callerFor(sessionFor(SENDER), db);

    await expect(
      caller.user.messages.sendMessage({ requestId: "nope", content: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.messages()).toEqual([]);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects an anonymous caller without writing or broadcasting", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "x",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(db.messages()).toEqual([]);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});

describe("sendMessage — only participants may write (SCRUM-222)", () => {
  it("refuses a third party with FORBIDDEN, writing nothing and broadcasting nothing", async () => {
    // The defect: any signed-in user holding a request id could inject a
    // message into a stranger's thread. It would be attributed to them in the
    // UI, broadcast on the conversation channel, and emailed.
    const { caller, db } = callerFor(sessionFor(OUTSIDER));

    await expect(
      caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "injected",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.messages()).toEqual([]);
    expect(db.prisma.message.create).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("does not create a conversation on behalf of a third party either", async () => {
    // Authorization has to precede find-or-create, or an unauthorized call
    // still leaves a conversation row behind.
    const db = buildMessageDb({ conversation: null });
    const { caller } = callerFor(sessionFor(OUTSIDER), db);

    await expect(
      caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "injected",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.prisma.conversation.create).not.toHaveBeenCalled();
    expect(db.prisma.request.update).not.toHaveBeenCalled();
  });

  it("still lets both real participants write", async () => {
    for (const party of [SENDER, RECIPIENT]) {
      const db = buildMessageDb();
      const { caller } = callerFor(sessionFor(party), db);

      await caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "hello",
      });

      expect(db.messages()).toHaveLength(1);
    }
  });
});

describe("user.messages.getMessages — removed rather than scoped", () => {
  it("is no longer exposed by the router", async () => {
    // It returned an entire conversation for any conversation id, having read
    // the session user and then never used it. Its only two callers ever came
    // in commits that were later reverted, so the surface was unreachable.
    const paths = Object.keys((appRouter as any)._def.procedures);

    expect(paths).toContain("user.messages.sendMessage");
    expect(paths).toContain("user.messages.markMessagesAsRead");
    expect(paths).not.toContain("user.messages.getMessages");
  });

  it("left the admin procedure of the same name alone", async () => {
    // `user.admin.getMessages` is a different, adminRouter-gated procedure that
    // AdminData.tsx does use; removing the messages one must not touch it.
    const paths = Object.keys((appRouter as any)._def.procedures);

    expect(paths).toContain("user.admin.getMessages");
  });
});
