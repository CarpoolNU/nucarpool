import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";

/**
 * `user.messages.conversation` — the paginated thread source.
 *
 * This procedure replaces `messages.getMessages`, which was **removed** rather
 * than scoped: it took a bare conversation id, returned every
 * message in it, and read the session user without ever using it, so any
 * signed-in caller could read any conversation. The whole point of the rewrite
 * is that authorization is derived from the request row, so the authorization
 * tests here are the ones that matter most — the pagination tests only protect
 * correctness.
 */

const OWNER = "user-owner";
const COUNTERPART = "user-counterpart";
const STRANGER = "user-stranger";

const REQUEST_ID = "request-1";
const CONVERSATION_ID = "conversation-1";

type MessageRow = {
  id: string;
  conversationId: string;
  content: string;
  userId: string;
  isRead: boolean;
  dateCreated: Date;
};

/** `n` messages, one minute apart, oldest first. */
const buildMessages = (n: number): MessageRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `message-${String(i + 1).padStart(3, "0")}`,
    conversationId: CONVERSATION_ID,
    content: `message ${i + 1}`,
    userId: i % 2 === 0 ? OWNER : COUNTERPART,
    isRead: false,
    dateCreated: new Date(2026, 0, 1, 12, i),
  }));

/**
 * Enough of Prisma to drive this one procedure: a request lookup, and a
 * `message.findMany` that honours `orderBy`, `take`, `cursor` and `skip` the
 * way the real client does.
 */
const buildDb = (opts?: {
  request?: { id: string; fromUserId: string; toUserId: string } | null;
  messages?: MessageRow[];
  conversationRequestId?: string;
}) => {
  const request =
    opts?.request === undefined
      ? { id: REQUEST_ID, fromUserId: OWNER, toUserId: COUNTERPART }
      : opts.request;
  const messages = opts?.messages ?? buildMessages(5);
  const conversationRequestId = opts?.conversationRequestId ?? REQUEST_ID;

  const findUnique = jest.fn(async ({ where }: any) =>
    request && request.id === where.id ? { ...request } : null,
  );

  const findMany = jest.fn(async (args: any) => {
    // The procedure scopes through `conversation.requestId`, which is unique.
    if (args.where?.conversation?.requestId !== conversationRequestId) {
      return [];
    }

    // Descending by (dateCreated, id), which is what the procedure asks for.
    const ordered = [...messages].sort((a, b) => {
      const byDate = b.dateCreated.getTime() - a.dateCreated.getTime();
      return byDate !== 0 ? byDate : b.id.localeCompare(a.id);
    });

    let start = 0;
    if (args.cursor?.id) {
      const at = ordered.findIndex((m) => m.id === args.cursor.id);
      // `skip: 1` means "strictly after the cursor row".
      start = at === -1 ? ordered.length : at + (args.skip ?? 0);
    }

    return ordered.slice(start, start + args.take).map((m) => ({ ...m }));
  });

  return {
    findUnique,
    findMany,
    prisma: {
      request: { findUnique },
      message: { findMany },
    },
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

const callerFor = (
  session: Session | null,
  db = buildDb(),
): { caller: ReturnType<typeof appRouter.createCaller>; db: typeof db } => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;
  return { caller: appRouter.createCaller(ctx), db };
};

describe("only participants may read a conversation", () => {
  it("refuses a third party with FORBIDDEN", async () => {
    const { caller } = callerFor(sessionFor(STRANGER));

    await expect(
      caller.user.messages.conversation({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reads no message content at all for a third party", async () => {
    // The defect being guarded against was disclosure, so it is not enough that
    // the call rejects — it must reject *before* touching the message table. A
    // filtered list or even a count would be a probe.
    const { caller, db } = callerFor(sessionFor(STRANGER));

    await expect(
      caller.user.messages.conversation({ requestId: REQUEST_ID }),
    ).rejects.toThrow();

    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("allows the request's sender", async () => {
    const { caller } = callerFor(sessionFor(OWNER));

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
    });

    expect(result.messages).toHaveLength(5);
  });

  it("allows the request's recipient", async () => {
    const { caller } = callerFor(sessionFor(COUNTERPART));

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
    });

    expect(result.messages).toHaveLength(5);
  });

  it("rejects an unauthenticated caller", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.messages.conversation({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("does not confirm or deny a conversation behind a missing request", async () => {
    const { caller, db } = callerFor(
      sessionFor(OWNER),
      buildDb({ request: null }),
    );

    await expect(
      caller.user.messages.conversation({ requestId: "no-such-request" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("authorizes against the stored row, not the caller's input", async () => {
    // The distinction that made the old procedure unsafe. A request id is no
    // more secret than a conversation id — knowing one must not be enough.
    const { caller, db } = callerFor(sessionFor(STRANGER));

    await expect(
      caller.user.messages.conversation({ requestId: REQUEST_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: REQUEST_ID } }),
    );
  });
});

describe("scoping", () => {
  it("scopes messages through the conversation's unique requestId", async () => {
    // Rather than through `Request.conversationId`. Both links exist; this is
    // the authoritative one, so a Request row whose scalar was never populated
    // cannot hide a thread.
    const { caller, db } = callerFor(sessionFor(OWNER));

    await caller.user.messages.conversation({ requestId: REQUEST_ID });

    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversation: { requestId: REQUEST_ID } },
      }),
    );
  });

  it("returns an empty page for a request whose conversation does not exist yet", async () => {
    // An ordinary state: `sendMessage` creates the conversation on first send.
    const { caller } = callerFor(
      sessionFor(OWNER),
      buildDb({ conversationRequestId: "some-other-request" }),
    );

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
    });

    expect(result.messages).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("never selects the author relation", async () => {
    const { caller, db } = callerFor(sessionFor(OWNER));

    await caller.user.messages.conversation({ requestId: REQUEST_ID });

    const args = db.findMany.mock.calls[0]![0];
    expect(args.select).not.toHaveProperty("User");
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select).sort()).toEqual([
      "content",
      "conversationId",
      "dateCreated",
      "id",
      "isRead",
      "userId",
    ]);
  });
});

describe("pagination", () => {
  it("returns the newest page first, in render order", async () => {
    const { caller } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(10) }),
    );

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
      limit: 4,
    });

    // Newest four, handed back oldest-first because that is how they render.
    expect(result.messages.map((m) => m.id)).toEqual([
      "message-007",
      "message-008",
      "message-009",
      "message-010",
    ]);
  });

  it("walks backwards through history without gaps or repeats", async () => {
    const { caller } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(10) }),
    );

    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;

    for (let page = 0; page < 10; page++) {
      const result = await caller.user.messages.conversation({
        requestId: REQUEST_ID,
        limit: 4,
        cursor,
      });
      seen.unshift(...result.messages.map((m) => m.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeNull();
    // Every message exactly once, in order.
    expect(seen).toEqual(buildMessages(10).map((m) => m.id));
    expect(new Set(seen).size).toBe(10);
  });

  it("orders by (dateCreated, id) so the cursor sits on a total order", async () => {
    // `dateCreated` alone is not unique — the seed writes several messages in
    // one transaction, and a fast sender can too. A cursor over a non-total
    // order skips or repeats rows.
    const { caller, db } = callerFor(sessionFor(OWNER));

    await caller.user.messages.conversation({ requestId: REQUEST_ID });

    expect(db.findMany.mock.calls[0]![0].orderBy).toEqual([
      { dateCreated: "desc" },
      { id: "desc" },
    ]);
  });

  it("reports no further pages once history is exhausted", async () => {
    const { caller } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(3) }),
    );

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
      limit: 10,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it("offers another page when exactly one more message exists", async () => {
    // The off-by-one worth pinning: `take: limit + 1` is how "is there more"
    // is answered, so a thread of exactly limit+1 must not look exhausted.
    const { caller } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(5) }),
    );

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
      limit: 4,
    });

    expect(result.messages).toHaveLength(4);
    expect(result.nextCursor).toBe("message-002");
  });

  it("does not report a further page when the thread is exactly one page", async () => {
    const { caller } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(4) }),
    );

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
      limit: 4,
    });

    expect(result.messages).toHaveLength(4);
    expect(result.nextCursor).toBeNull();
  });

  it("never returns more rows than the limit", async () => {
    const { caller, db } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(50) }),
    );

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
      limit: 7,
    });

    expect(result.messages).toHaveLength(7);
    // One extra is fetched to detect the next page, and must not be returned.
    expect(db.findMany.mock.calls[0]![0].take).toBe(8);
  });

  it("defaults to a page larger than a screenful", async () => {
    const { caller, db } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(100) }),
    );

    await caller.user.messages.conversation({ requestId: REQUEST_ID });

    expect(db.findMany.mock.calls[0]![0].take).toBe(31);
  });

  it("refuses a limit large enough to defeat the point", async () => {
    const { caller } = callerFor(sessionFor(OWNER));

    await expect(
      caller.user.messages.conversation({ requestId: REQUEST_ID, limit: 5000 }),
    ).rejects.toThrow();
  });

  it("refuses a zero or negative limit", async () => {
    const { caller } = callerFor(sessionFor(OWNER));

    for (const limit of [0, -1]) {
      await expect(
        caller.user.messages.conversation({ requestId: REQUEST_ID, limit }),
      ).rejects.toThrow();
    }
  });

  it("skips the cursor row itself rather than repeating it", async () => {
    const { caller, db } = callerFor(
      sessionFor(OWNER),
      buildDb({ messages: buildMessages(10) }),
    );

    await caller.user.messages.conversation({
      requestId: REQUEST_ID,
      cursor: "message-007",
      limit: 3,
    });

    const args = db.findMany.mock.calls[0]![0];
    expect(args.cursor).toEqual({ id: "message-007" });
    expect(args.skip).toBe(1);
  });

  it("sends no cursor at all on the first page", async () => {
    // Passing `cursor: undefined` to Prisma is not the same as omitting it.
    const { caller, db } = callerFor(sessionFor(OWNER));

    await caller.user.messages.conversation({ requestId: REQUEST_ID });

    const args = db.findMany.mock.calls[0]![0];
    expect(args).not.toHaveProperty("cursor");
    expect(args).not.toHaveProperty("skip");
  });
});

describe("what the card list and unread state still need", () => {
  it("carries isRead, userId and dateCreated on every message", async () => {
    // `getCardSortingData` derives the unread dot from these, and
    // `markMessagesAsRead` needs `id` and `isRead` on the visible thread.
    const { caller } = callerFor(sessionFor(OWNER));

    const result = await caller.user.messages.conversation({
      requestId: REQUEST_ID,
    });

    for (const message of result.messages) {
      expect(message).toHaveProperty("id");
      expect(message).toHaveProperty("isRead");
      expect(message).toHaveProperty("userId");
      expect(message).toHaveProperty("dateCreated");
    }
  });
});
