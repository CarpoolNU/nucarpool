import { Permission } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import { cloneState, withTransaction } from "../transactionMock";

/**
 * Authorization tests for the `user.requests` router (SCRUM-221).
 *
 * Three defects are pinned here:
 *
 *  1. `create` took the sender as a client-supplied `fromId` and connected it as
 *     the request's `fromUser`, so any signed-in caller could send a carpool
 *     request that appeared to come from someone else.
 *  2. `delete` looked the request up by id and deleted it with no check that the
 *     caller was a party to it, so anyone could clear strangers' requests.
 *  3. `edit` rewrote any request's stored message by id, also unchecked. It had
 *     no caller anywhere in `src/` and was removed rather than authorized.
 *
 * Following `favorites.test.ts` and `authorization.test.ts`, these drive the
 * real `appRouter` through `createCaller` with a fabricated session and a mocked
 * Prisma client — no database, no new test framework. The mock is not inert: it
 * keeps requests, conversations and messages in memory and applies writes, so a
 * test can assert the *effect* of a mutation (which rows exist, and who they say
 * they are from) rather than only which arguments Prisma received. It is a
 * stand-in for a database, not a substitute for one — see SCRUM-263.
 */

const USER_A = "user-a";
const USER_B = "user-b";
const USER_C = "user-c";

type RequestRow = {
  id: string;
  message: string;
  fromUserId: string;
  toUserId: string;
  conversationId: string | null;
};

const requestRow = (
  id: string,
  fromUserId: string,
  toUserId: string,
): RequestRow => ({
  id,
  message: "",
  fromUserId,
  toUserId,
  conversationId: null,
});

/**
 * A Prisma double backed by in-memory maps. Only the shapes these two
 * procedures actually issue are supported; anything else throws loudly rather
 * than quietly returning undefined.
 */
const buildRequestsDb = (seed: RequestRow[] = []) => {
  const requests = new Map<string, RequestRow>(
    seed.map((row) => [row.id, { ...row }]),
  );
  const conversations = new Map<string, { id: string; requestId: string }>();
  const messages: {
    conversationId: string;
    content: string;
    userId: string;
  }[] = [];
  let created = 0;

  const findMany = jest.fn(async ({ where }: any) => {
    // The duplicate guard is the only caller: an OR of two {from,to} pairs.
    const clauses: any[] = where?.OR ?? [where ?? {}];
    return [...requests.values()].filter((row) =>
      clauses.some(
        (clause) =>
          clause.fromUserId === row.fromUserId &&
          clause.toUserId === row.toUserId,
      ),
    );
  });

  const create = jest.fn(async ({ data }: any) => {
    const row: RequestRow = {
      id: `request-${++created}`,
      message: data.message,
      fromUserId: data.fromUser.connect.id,
      toUserId: data.toUser.connect.id,
      conversationId: null,
    };
    requests.set(row.id, row);
    return { ...row };
  });

  const findUnique = jest.fn(async ({ where }: any) => {
    const row = requests.get(where.id);
    return row ? { ...row } : null;
  });

  const update = jest.fn(async ({ where, data }: any) => {
    const row = requests.get(where.id);
    if (!row) throw new Error(`No request row matching where.id=${where.id}`);
    Object.assign(row, data);
    return { ...row };
  });

  const destroy = jest.fn(async ({ where }: any) => {
    const row = requests.get(where.id);
    if (!row) throw new Error(`No request row matching where.id=${where.id}`);
    requests.delete(where.id);
    return { ...row };
  });

  const conversationFindUnique = jest.fn(async ({ where }: any) => {
    const found = [...conversations.values()].find(
      (c) => c.requestId === where.requestId,
    );
    return found ? { ...found } : null;
  });

  const conversationCreate = jest.fn(async ({ data }: any) => {
    const row = {
      id: `conversation-${data.requestId}`,
      requestId: data.requestId,
    };
    conversations.set(row.id, row);

    // `requests.create` writes the conversation and its first message as one
    // nested create (SCRUM-233), so the mock has to honour the nested form or
    // the first message would silently vanish here and nowhere else.
    if (data.messages?.create) {
      const nested = Array.isArray(data.messages.create)
        ? data.messages.create
        : [data.messages.create];
      for (const message of nested) {
        messages.push({
          conversationId: row.id,
          content: message.content,
          userId: message.userId,
        });
      }
    }

    return { ...row };
  });

  const messageCreate = jest.fn(async ({ data }: any) => {
    messages.push({
      conversationId: data.conversationId,
      content: data.content,
      userId: data.userId,
    });
    return { id: `message-${messages.length}`, ...data };
  });

  // `requests.create` commits its four writes as one transaction (SCRUM-233),
  // so the mock rolls back on a throw rather than merely passing through.
  const prisma = withTransaction(
    {
      request: { findMany, create, findUnique, update, delete: destroy },
      conversation: {
        findUnique: conversationFindUnique,
        create: conversationCreate,
      },
      message: { create: messageCreate },
    },
    () => ({
      requests: cloneState(requests),
      conversations: cloneState(conversations),
      messages: cloneState(messages),
    }),
    (before) => {
      requests.clear();
      for (const [id, row] of before.requests) requests.set(id, row);
      conversations.clear();
      for (const [id, row] of before.conversations) conversations.set(id, row);
      messages.length = 0;
      messages.push(...before.messages);
    },
  );

  return {
    prisma,
    /** Every surviving request row, ordered by id for stable assertions. */
    rows: () => [...requests.values()].sort((a, b) => a.id.localeCompare(b.id)),
    messages: () => [...messages],
    create,
    destroy,
    update,
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

const callerFor = (session: Session | null, db = buildRequestsDb()) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db };
};

/**
 * `fromId` is gone from the input type, so an attacker-shaped payload cannot be
 * expressed in TypeScript. Casting through `unknown` reaches past the compiler
 * to exercise what an untrusted HTTP client can actually send, as
 * `favorites.test.ts` does.
 */
type CreateInput = Parameters<
  ReturnType<typeof appRouter.createCaller>["user"]["requests"]["create"]
>[0];

const asCreateInput = (payload: Record<string, unknown>) =>
  payload as unknown as CreateInput;

describe("user.requests.create — the sender comes from the session", () => {
  it("records the caller as the sender", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.rows()).toEqual([
      expect.objectContaining({ fromUserId: USER_A, toUserId: USER_B }),
    ]);
  });

  it("uses whichever user is authenticated, not a fixed one", async () => {
    // Guards against a "fix" that hardcodes an id or reads the wrong session field.
    const { caller, db } = callerFor(sessionFor(USER_C));

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.rows()).toEqual([
      expect.objectContaining({ fromUserId: USER_C, toUserId: USER_B }),
    ]);
  });

  it("attributes the opening message to the caller", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: "hello", userId: USER_A }),
    ]);
  });

  it("rejects a payload carrying another user's id as the sender", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.requests.create(
        asCreateInput({
          fromId: USER_B,
          toId: USER_C,
          message: "impersonated",
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Rejected at input validation, so nothing was written at all.
    expect(db.create).not.toHaveBeenCalled();
    expect(db.rows()).toEqual([]);
    expect(db.messages()).toEqual([]);
  });

  it("rejects a payload that supplies the caller's own id, because the field is gone", async () => {
    // Even a "harmless" fromId is refused: the field must not exist in the
    // contract, or a future resolver could start trusting it again.
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.requests.create(
        asCreateInput({ fromId: USER_A, toId: USER_B, message: "hello" }),
      ),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(db.create).not.toHaveBeenCalled();
  });

  it("never writes a request whose sender is not the caller", async () => {
    // The property that actually matters, asserted over every accepted call.
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: "one" });
    await caller.user.requests.create({ toId: USER_C, message: "two" });

    expect(db.rows()).toHaveLength(2);
    for (const row of db.rows()) {
      expect(row.fromUserId).toBe(USER_A);
    }
  });
});

describe("user.requests.create — the duplicate guard still holds", () => {
  it("refuses a second request to the same person", async () => {
    const db = buildRequestsDb([requestRow("existing", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "again" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses a request to someone who already requested the caller", async () => {
    // The guard is direction-agnostic; the reverse pair must still match now
    // that it is keyed off the session rather than a client-supplied id.
    const db = buildRequestsDb([requestRow("existing", USER_B, USER_A)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "again" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.create).not.toHaveBeenCalled();
  });

  it("is scoped to the caller, so other people's requests do not block them", async () => {
    // A pre-existing B→C request must not stop A from requesting C.
    const db = buildRequestsDb([requestRow("other-pair", USER_B, USER_C)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_C, message: "hello" });

    // rows() sorts by id, so the seeded pair comes first.
    expect(db.rows()).toEqual([
      expect.objectContaining({ id: "other-pair", fromUserId: USER_B }),
      expect.objectContaining({ fromUserId: USER_A, toUserId: USER_C }),
    ]);
  });
});

describe("user.requests.create — a caller cannot request themselves", () => {
  /**
   * SCRUM-278. The UI never produces this — ConnectModal opens from someone
   * else's card — but `toId` is client input on a mutation any signed-in
   * caller can reach.
   *
   * The duplicate guard cannot catch it. For a self-request both halves of
   * its `OR` are `{ fromUserId: me, toUserId: me }`, so nothing pre-existing
   * matches on the first attempt and the row is created.
   */
  it("rejects a request whose recipient is the caller", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.requests.create({ toId: USER_A, message: "hello" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.rows()).toEqual([]);
  });

  it("writes no Conversation or Message either", async () => {
    // The row is not the only thing `create` produces, and the two it leaves
    // behind outlive it: `delete` removes only the Request, so a self-request
    // that got through would strand its Conversation and Message for good.
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.requests.create({ toId: USER_A, message: "hello" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.prisma.conversation.create).not.toHaveBeenCalled();
    expect(db.prisma.message.create).not.toHaveBeenCalled();
  });

  it("rejects before querying for duplicates at all", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.requests.create({ toId: USER_A, message: "hello" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.prisma.request.findMany).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it("still allows a request to somebody else", async () => {
    // The guard compares against the session id, so it must not reject on any
    // other basis — a check on the wrong variable would fail here.
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.rows()).toEqual([
      expect.objectContaining({ fromUserId: USER_A, toUserId: USER_B }),
    ]);
  });

  it("compares against the session, not a fixed id", async () => {
    // The same `toId` that is a self-request for USER_A is an ordinary request
    // for anyone else. Without this, a guard that rejected USER_A outright —
    // or compared the wrong pair of variables — would still look correct.
    const { caller, db } = callerFor(sessionFor(USER_B));

    await caller.user.requests.create({ toId: USER_A, message: "hello" });

    expect(db.rows()).toEqual([
      expect.objectContaining({ fromUserId: USER_B, toUserId: USER_A }),
    ]);
  });
});

describe("user.requests.delete — only a participant may clear a request", () => {
  const seeded = () => buildRequestsDb([requestRow("req-1", USER_A, USER_B)]);

  it("lets the sender withdraw their own request", async () => {
    const db = seeded();
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.delete({ invitationId: "req-1" });

    expect(db.rows()).toEqual([]);
  });

  it("lets the recipient decline the request", async () => {
    const db = seeded();
    const { caller } = callerFor(sessionFor(USER_B), db);

    await caller.user.requests.delete({ invitationId: "req-1" });

    expect(db.rows()).toEqual([]);
  });

  it("refuses a third party with FORBIDDEN and leaves the request intact", async () => {
    const db = seeded();
    const { caller } = callerFor(sessionFor(USER_C), db);

    await expect(
      caller.user.requests.delete({ invitationId: "req-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.destroy).not.toHaveBeenCalled();
    expect(db.rows()).toEqual([expect.objectContaining({ id: "req-1" })]);
  });

  it("still reports NOT_FOUND for an id that does not exist", async () => {
    const db = seeded();
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.delete({ invitationId: "no-such-request" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(db.destroy).not.toHaveBeenCalled();
    expect(db.rows()).toHaveLength(1);
  });
});

describe("user.requests — authentication gate", () => {
  it("rejects an anonymous create without touching the database", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("rejects an anonymous delete without touching the database", async () => {
    const { caller, db } = callerFor(null);

    await expect(
      caller.user.requests.delete({ invitationId: "req-1" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(db.destroy).not.toHaveBeenCalled();
  });

  it("rejects a session that carries no user", async () => {
    // protectedRouter only checks that a session exists; each resolver's own
    // guard answers the missing-user case.
    const noUser = {
      expires: "2099-01-01T00:00:00.000Z",
      user: undefined,
    } as Session;

    const { caller: createCaller_, db: createDb } = callerFor(noUser);
    await expect(
      createCaller_.user.requests.create({ toId: USER_B, message: "hello" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(createDb.create).not.toHaveBeenCalled();

    const { caller: deleteCaller, db: deleteDb } = callerFor(noUser);
    await expect(
      deleteCaller.user.requests.delete({ invitationId: "req-1" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(deleteDb.destroy).not.toHaveBeenCalled();
  });
});

describe("user.requests.edit — removed rather than authorized", () => {
  it("is no longer exposed by the router", async () => {
    // It had no caller in `src/`, so unauthenticated-but-unreachable API surface
    // was deleted instead of being given an ownership check.
    const paths = Object.keys((appRouter as any)._def.procedures);

    expect(paths).toContain("user.requests.create");
    expect(paths).toContain("user.requests.delete");
    expect(paths).not.toContain("user.requests.edit");
  });
});

describe("user.requests.create — the opening message is bounded (SCRUM-231)", () => {
  // The input goes to `message.content`, not to `request.message`: the handler
  // writes `""` to the request row and puts the text in the conversation's
  // first `Message`. Both columns are `VARCHAR(255)`; neither was bounded here.
  const atLimit = "a".repeat(MESSAGE_MAX_LENGTH);

  it("accepts a message of exactly the column width", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: atLimit });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: atLimit }),
    ]);
  });

  it("rejects one character past it, creating no request at all", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await expect(
      caller.user.requests.create({ toId: USER_B, message: `${atLimit}!` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // The row, its conversation and its message are three separate writes, and
    // the length failure used to land on the last of them.
    expect(db.rows()).toEqual([]);
    expect(db.messages()).toEqual([]);
  });

  it("still allows a request with no message", async () => {
    // ConnectModal's textarea starts empty and its Send button never required
    // text, so `.min(1)` here would break a supported flow.
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: "" });

    expect(db.rows()).toEqual([
      expect.objectContaining({ fromUserId: USER_A, toUserId: USER_B }),
    ]);
  });
});

/**
 * Atomicity of `user.requests.create` (SCRUM-233).
 *
 * A request, its conversation, the link between them and the first message used
 * to be four independent awaits, so a failure part-way through could leave a
 * request with no conversation, or a conversation never linked back to its
 * request. `relationMode = "prisma"` rejects neither, and nothing reconciles
 * them afterwards, so the half-built thread persisted.
 */
describe("user.requests.create is atomic", () => {
  it("leaves no request, conversation or message when the link write fails", async () => {
    const db = buildRequestsDb();
    const { caller } = callerFor(sessionFor(USER_A), db);

    // The request and the conversation-with-message are already written by the
    // time the link is set, so this is the failure that used to survive.
    db.update.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).rejects.toThrow("connection lost");

    expect(db.rows()).toEqual([]);
    expect(db.messages()).toEqual([]);
  });

  it("writes the opening message exactly once on the happy path", async () => {
    // The conversation and its first message are now a single nested create.
    // A nested form the mock did not understand would silently drop the
    // message, so this pins that it still arrives — and only once.
    const db = buildRequestsDb();
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: "hello", userId: USER_A }),
    ]);
  });

  it("no longer looks for a conversation that cannot exist yet", async () => {
    // The request is created a statement earlier with a fresh cuid, so nothing
    // could reference it: the old `conversation.findUnique({ requestId })` could
    // only ever return null, making the false branch of its `if` unreachable.
    const db = buildRequestsDb();
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.prisma.conversation.findUnique).not.toHaveBeenCalled();
  });
});
