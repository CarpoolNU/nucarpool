import { Permission, Role } from "@prisma/client";
import type { Session } from "next-auth";
import type { Context } from "../context";
import {
  conversationChannel,
  notificationChannel,
} from "../../../utils/pusherChannels";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import { cloneState, withTransaction } from "../transactionMock";

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

  const delegates = {
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

  // `sendMessage` repairs a missing conversation and writes the message as one
  // transaction (SCRUM-233). `conversation` and `linkedConversationId` are
  // rebound rather than mutated, so restoring them is a plain assignment here
  // rather than an in-place edit through a shared reference.
  const prisma = withTransaction(
    delegates,
    () => ({
      conversation: cloneState(conversation),
      linkedConversationId,
      messages: cloneState(messages),
    }),
    (before) => {
      conversation = before.conversation;
      linkedConversationId = before.linkedConversationId;
      messages.length = 0;
      messages.push(...before.messages);
    },
  );

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
  triggeredChannels().filter((c: string) =>
    c.startsWith("private-notification-"),
  );

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

    expect(notificationChannels()).toEqual([notificationChannel(RECIPIENT)]);
  });

  it("notifies the request's sender when the recipient replies", async () => {
    // The defect: this used to address `toUserId` — the replier's own channel —
    // so the original sender never saw the badge increment.
    const { caller } = callerFor(sessionFor(RECIPIENT));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "replying",
    });

    expect(notificationChannels()).toEqual([notificationChannel(SENDER)]);
  });

  it("never notifies the author of the message", async () => {
    for (const author of [SENDER, RECIPIENT]) {
      mockTrigger.mockClear();
      const { caller } = callerFor(sessionFor(author));

      await caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "x",
      });

      expect(notificationChannels()).not.toContain(notificationChannel(author));
    }
  });

  it("always broadcasts on the conversation channel as well", async () => {
    const { caller } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(triggeredChannels()).toContain(conversationChannel(REQUEST_ID));
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

    expect(notificationChannels()).toEqual([notificationChannel(SENDER)]);
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

  it("no longer has an admin counterpart either", async () => {
    // `user.admin.getMessages` was a separate, adminRouter-gated procedure that
    // SCRUM-222 deliberately left alone. SCRUM-246 then removed it too, for a
    // different reason: it selected `content`, so it shipped the text of every
    // private message to an admin's browser, and AdminData.tsx never read the
    // result. No procedure in the router selects a message body now.
    const paths = Object.keys((appRouter as any)._def.procedures);

    expect(paths).not.toContain("user.admin.getMessages");
  });
});

describe("sendMessage — broadcasts only on private channels (SCRUM-224)", () => {
  it("uses the private- prefix on every channel it triggers", async () => {
    // Without the prefix Pusher treats the channel as public and never calls
    // the auth endpoint, so the subscription check silently stops applying.
    const { caller } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "hello",
    });

    expect(triggeredChannels()).toHaveLength(2);
    for (const channel of triggeredChannels()) {
      expect(channel).toMatch(/^private-/);
    }
  });
});

describe("sendMessage — content is bounded by its column (SCRUM-231)", () => {
  // `message.content` is `VARCHAR(255)` and MySQL runs in strict mode, so an
  // oversized value threw at the database rather than truncating. The input had
  // neither `.max()` nor `.min(1)`, and `SendBar` had no cap at all, so the
  // user's text was cleared from the box for a write that never landed.
  const atLimit = "a".repeat(MESSAGE_MAX_LENGTH);

  it("accepts a message of exactly the column width", async () => {
    const { caller, db } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: atLimit,
    });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: atLimit }),
    ]);
  });

  it("rejects one character past it, writing nothing and broadcasting nothing", async () => {
    const { caller, db } = callerFor(sessionFor(SENDER));

    await expect(
      caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: `${atLimit}!`,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.messages()).toEqual([]);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects empty and whitespace-only content", async () => {
    // `SendBar` refuses to send these, but the procedure is reachable without
    // it, and an empty row renders as a blank bubble in the thread.
    for (const content of ["", "   ", "\n\t"]) {
      const { caller, db } = callerFor(sessionFor(SENDER));

      await expect(
        caller.user.messages.sendMessage({ requestId: REQUEST_ID, content }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(db.messages()).toEqual([]);
    }
  });

  it("stores the trimmed text, so padding cannot buy extra width", async () => {
    const { caller, db } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: "  hello  ",
    });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: "hello" }),
    ]);
  });

  it("measures the trimmed text against the limit", async () => {
    // Trim runs before the length check, so surrounding whitespace on an
    // otherwise legal message is not what pushes it over.
    const { caller, db } = callerFor(sessionFor(SENDER));

    await caller.user.messages.sendMessage({
      requestId: REQUEST_ID,
      content: `   ${atLimit}   `,
    });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: atLimit }),
    ]);
  });
});

/**
 * Atomicity of `sendMessage` (SCRUM-233).
 *
 * Repairing a missing conversation takes two writes, because the link lives on
 * both `Conversation.requestId` and `Request.conversationId`. Untransactioned,
 * those plus the message were three independent awaits, so a failure could
 * create and link a conversation and then lose the text the user had typed.
 */
describe("sendMessage is atomic", () => {
  it("leaves no conversation behind when writing the message fails", async () => {
    // No conversation yet, so this exercises the repair path added by
    // SCRUM-230 — the one that writes twice before the message.
    const db = buildMessageDb({ conversation: null });
    const { caller } = callerFor(sessionFor(SENDER), db);

    db.prisma.message.create.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "hello",
      }),
    ).rejects.toThrow("connection lost");

    expect(db.conversationId()).toBeNull();
    expect(db.linkedConversationId()).toBeNull();
    expect(db.messages()).toEqual([]);
  });

  it("broadcasts nothing when the write fails", async () => {
    // Pusher sits outside the transaction on purpose: an event cannot be rolled
    // back. That is only safe while it stays strictly downstream of the write,
    // which is what this pins — move a trigger above the transaction and this
    // fails. Note it asserts ordering, not rollback: the throw short-circuits
    // before Pusher either way.
    const db = buildMessageDb({ conversation: null });
    const { caller } = callerFor(sessionFor(SENDER), db);

    db.prisma.message.create.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      caller.user.messages.sendMessage({
        requestId: REQUEST_ID,
        content: "hello",
      }),
    ).rejects.toThrow("connection lost");

    expect(triggeredChannels()).toEqual([]);
  });
});

/**
 * `getUnreadMessageCount` counts the caller's own conversations, and nothing
 * about the counterpart's role (SCRUM-296).
 *
 * It used to require the counterpart's role to differ from the caller's and not
 * be VIEWER - the same predicate `user.requests.me` applied to the list - so
 * once either party changed role the two disagreed in both directions at once:
 * the thread was hidden from the Requests tab, and its unread messages were
 * dropped from the header badge, which is how replies became invisible rather
 * than merely unreachable.
 *
 * The double below understands the role predicate as well as the plain one, so
 * a regression that reintroduces it changes these counts rather than being
 * quietly ignored.
 */
type UnreadUser = { id: string; role: Role };
type UnreadRequest = { fromUserId: string; toUserId: string };
type UnreadMessage = {
  conversationId: string;
  userId: string;
  isRead: boolean;
};

/** Matches `{ role: { not: X }, AND: { role: { not: "VIEWER" } } }` and friends. */
const matchesRolePredicate = (role: Role, predicate: any): boolean => {
  if (!predicate) return true;

  if (predicate.role) {
    if ("not" in predicate.role && role === predicate.role.not) return false;
    if ("in" in predicate.role && !predicate.role.in.includes(role)) {
      return false;
    }
  }

  return matchesRolePredicate(role, predicate.AND);
};

const buildUnreadDb = (
  users: UnreadUser[],
  requests: UnreadRequest[],
  messages: UnreadMessage[],
) => {
  const roleOf = (id: string) => users.find((u) => u.id === id)?.role;

  /** One `some` clause of the request OR, against one request row. */
  const requestMatches = (clause: any, request: UnreadRequest): boolean => {
    if (clause.fromUserId && clause.fromUserId !== request.fromUserId) {
      return false;
    }
    if (clause.toUserId && clause.toUserId !== request.toUserId) return false;

    for (const [side, otherId] of [
      ["toUser", request.toUserId],
      ["fromUser", request.fromUserId],
    ] as const) {
      const nested = clause[side]?.carpoolSearches?.some;
      if (!nested) continue;

      const role = roleOf(otherId);
      if (role === undefined || !matchesRolePredicate(role, nested)) {
        return false;
      }
    }

    return true;
  };

  const count = jest.fn(async ({ where }: any) => {
    const clauses: any[] = where?.conversation?.request?.some?.OR ?? [];

    return messages.filter((message) => {
      if (where?.isRead !== undefined && message.isRead !== where.isRead) {
        return false;
      }
      if (where?.userId?.not && message.userId === where.userId.not) {
        return false;
      }

      // Every request in this suite carries the conversation of the same name,
      // which is enough: `some` only has to find one matching request.
      return requests.some(
        (request) =>
          `conversation-${request.fromUserId}-${request.toUserId}` ===
            message.conversationId &&
          clauses.some((clause) => requestMatches(clause, request)),
      );
    }).length;
  });

  // Provided even though the resolver no longer reads it, so that a regression
  // reintroducing the role comparison fails on the count rather than crashing
  // on an absent delegate.
  const carpoolSearchFindFirst = jest.fn(async ({ where }: any) => {
    const role = roleOf(where.userId);
    return role === undefined ? null : { role };
  });

  return {
    prisma: {
      message: { count },
      carpoolSearch: { findFirst: carpoolSearchFindFirst },
    } as unknown as Context["prisma"],
    count,
    carpoolSearchFindFirst,
  };
};

const unreadCallerFor = (
  userId: string,
  users: UnreadUser[],
  requests: UnreadRequest[],
  messages: UnreadMessage[],
) => {
  const db = buildUnreadDb(users, requests, messages);
  const ctx = {
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db };
};

const conversationOf = (from: string, to: string) =>
  `conversation-${from}-${to}`;

describe("getUnreadMessageCount - the badge and the Requests tab agree", () => {
  const pair: UnreadRequest[] = [{ fromUserId: SENDER, toUserId: RECIPIENT }];
  const unreadFromRecipient: UnreadMessage[] = [
    {
      conversationId: conversationOf(SENDER, RECIPIENT),
      userId: RECIPIENT,
      isRead: false,
    },
  ];

  it("counts an unread reply from a counterpart who now shares the caller's role", async () => {
    // The state SCRUM-296 describes: both riders, so the old predicate excluded
    // the thread and the reply never reached the badge.
    const { caller } = unreadCallerFor(
      SENDER,
      [
        { id: SENDER, role: Role.RIDER },
        { id: RECIPIENT, role: Role.RIDER },
      ],
      pair,
      unreadFromRecipient,
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(1);
  });

  it("counts one from a counterpart who has switched to VIEWER", async () => {
    const { caller } = unreadCallerFor(
      SENDER,
      [
        { id: SENDER, role: Role.RIDER },
        { id: RECIPIENT, role: Role.VIEWER },
      ],
      pair,
      unreadFromRecipient,
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(1);
  });

  it("counts messages received as well as sent, in either direction", async () => {
    const { caller } = unreadCallerFor(
      RECIPIENT,
      [
        { id: SENDER, role: Role.DRIVER },
        { id: RECIPIENT, role: Role.DRIVER },
      ],
      pair,
      [
        {
          conversationId: conversationOf(SENDER, RECIPIENT),
          userId: SENDER,
          isRead: false,
        },
      ],
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(1);
  });

  it("still counts the ordinary compatible pair", async () => {
    const { caller } = unreadCallerFor(
      SENDER,
      [
        { id: SENDER, role: Role.RIDER },
        { id: RECIPIENT, role: Role.DRIVER },
      ],
      pair,
      unreadFromRecipient,
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(1);
  });

  it("never counts the caller's own messages, or ones already read", async () => {
    const { caller } = unreadCallerFor(
      SENDER,
      [
        { id: SENDER, role: Role.RIDER },
        { id: RECIPIENT, role: Role.RIDER },
      ],
      pair,
      [
        {
          conversationId: conversationOf(SENDER, RECIPIENT),
          userId: SENDER,
          isRead: false,
        },
        {
          conversationId: conversationOf(SENDER, RECIPIENT),
          userId: RECIPIENT,
          isRead: true,
        },
      ],
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(0);
  });

  it("never counts a conversation the caller is not a party to", async () => {
    // The scoping this query does carry, and the reason the role predicate was
    // never what kept the count private.
    const { caller } = unreadCallerFor(
      OUTSIDER,
      [
        { id: SENDER, role: Role.RIDER },
        { id: RECIPIENT, role: Role.DRIVER },
        { id: OUTSIDER, role: Role.RIDER },
      ],
      pair,
      unreadFromRecipient,
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(0);
  });

  it("asks the database nothing about anyone's role", async () => {
    const { caller, db } = unreadCallerFor(
      SENDER,
      [
        { id: SENDER, role: Role.RIDER },
        { id: RECIPIENT, role: Role.RIDER },
      ],
      pair,
      unreadFromRecipient,
    );

    await caller.user.messages.getUnreadMessageCount();

    expect(db.count).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.count.mock.calls[0]?.[0])).not.toContain("role");
  });

  it("returns a count rather than NOT_FOUND for a caller with no CarpoolSearch", async () => {
    // The caller's own search was read only for the role comparison, and its
    // absence threw NOT_FOUND - which reached the header as a failed query
    // rather than a number. Nothing about "how many unread messages are mine"
    // depends on it.
    const { caller } = unreadCallerFor(
      SENDER,
      [{ id: RECIPIENT, role: Role.RIDER }],
      pair,
      unreadFromRecipient,
    );

    await expect(caller.user.messages.getUnreadMessageCount()).resolves.toBe(1);
  });

  it("rejects an anonymous caller without counting anything", async () => {
    const db = buildUnreadDb([], [], []);
    const ctx = {
      req: undefined,
      res: undefined,
      session: null,
      prisma: db.prisma,
      sesClient: { send: jest.fn() },
    } as unknown as Context;

    await expect(
      appRouter.createCaller(ctx).user.messages.getUnreadMessageCount(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.count).not.toHaveBeenCalled();
  });
});
