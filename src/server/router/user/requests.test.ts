import { Permission, RequestStatus, Role, Status } from "@prisma/client";
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
  status: RequestStatus;
  fromUserId: string;
  toUserId: string;
  conversationId: string | null;
};

const requestRow = (
  id: string,
  fromUserId: string,
  toUserId: string,
  overrides: Partial<RequestRow> = {},
): RequestRow => ({
  id,
  message: "",
  status: RequestStatus.PENDING,
  fromUserId,
  toUserId,
  conversationId: null,
  ...overrides,
});

/**
 * A Prisma double backed by in-memory maps. Only the shapes these two
 * procedures actually issue are supported; anything else throws loudly rather
 * than quietly returning undefined.
 */
const buildRequestsDb = (
  seed: RequestRow[] = [],
  /** userId -> carpoolId, for the "already carpooling together" guard. */
  groupMembership: Record<string, string | null> = {},
  /**
   * userId -> email, for the notifiability guard (SCRUM-292). Everyone has one
   * unless a test says otherwise, because that is the ordinary case: the field
   * comes from Azure AD at sign-in.
   */
  emails: Record<string, string | null> = {},
) => {
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

  const findFirst = jest.fn(async (args: any) => {
    const matches = await findMany(args);
    return matches[0] ? { ...matches[0] } : null;
  });

  const carpoolSearchFindMany = jest.fn(async ({ where }: any) => {
    const ids: string[] = where?.userId?.in ?? [];
    return ids.map((userId) => ({
      userId,
      carpoolId: groupMembership[userId] ?? null,
    }));
  });

  const create = jest.fn(async ({ data }: any) => {
    const row: RequestRow = {
      id: `request-${++created}`,
      message: data.message,
      status: RequestStatus.PENDING,
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

  // `create` reads both parties' addresses to check the request can be
  // notified (SCRUM-292).
  const userFindMany = jest.fn(async ({ where }: any) => {
    const ids: string[] = where?.id?.in ?? [];
    return ids.map((id) => ({
      id,
      email: id in emails ? emails[id] : `${id}@northeastern.edu`,
    }));
  });

  // `requests.create` commits its four writes as one transaction (SCRUM-233),
  // so the mock rolls back on a throw rather than merely passing through.
  const prisma = withTransaction(
    {
      request: {
        findMany,
        findFirst,
        create,
        findUnique,
        update,
        delete: destroy,
      },
      carpoolSearch: { findMany: carpoolSearchFindMany },
      user: { findMany: userFindMany },
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

/**
 * Reopening an accepted request (SCRUM-228).
 *
 * Accepting used to leave the row pending forever, and the duplicate guard above
 * refuses any existing request between a pair in either direction — so once two
 * people had carpooled together, they could never request each other again. The
 * guard now only counts PENDING rows, and an ACCEPTED one is reopened in place
 * rather than joined by a second row: `extendPublicUser` resolves a user's
 * request with `.find()`, so two rows would make the conversation the UI shows
 * arbitrary.
 */
describe("user.requests.create — an accepted request is reopened, not duplicated", () => {
  const accepted = (id: string, from: string, to: string) =>
    requestRow(id, from, to, {
      status: RequestStatus.ACCEPTED,
      conversationId: `conversation-${id}`,
    });

  it("lets a pair who previously carpooled request each other again", async () => {
    const db = buildRequestsDb([accepted("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "round two" }),
    ).resolves.toMatchObject({ status: RequestStatus.PENDING });
  });

  it("reuses the existing row rather than adding a second one", async () => {
    const db = buildRequestsDb([accepted("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "round two" });

    expect(db.rows()).toHaveLength(1);
    expect(db.rows()[0].id).toBe("old");
    expect(db.create).not.toHaveBeenCalled();
  });

  it("rewrites the direction, because whoever asks now is the sender now", async () => {
    // The first request went A -> B. B is the one asking this time.
    const db = buildRequestsDb([accepted("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_B), db);

    await caller.user.requests.create({ toId: USER_A, message: "your turn" });

    expect(db.rows()[0]).toMatchObject({
      fromUserId: USER_B,
      toUserId: USER_A,
      status: RequestStatus.PENDING,
    });
  });

  it("keeps the pair's conversation, appending the new message to it", async () => {
    const db = buildRequestsDb([accepted("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "round two" });

    // The conversation hangs off the request id, which has not changed.
    expect(db.rows()[0].conversationId).toBe("conversation-old");
    expect(db.messages()).toEqual([
      {
        conversationId: "conversation-old",
        content: "round two",
        userId: USER_A,
      },
    ]);
  });

  it("adds nothing to the thread when the new request carries no message", async () => {
    // A bare request is a real flow, but an empty row in an existing thread is
    // just noise — unlike a first request, where it is the only message there is.
    const db = buildRequestsDb([accepted("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "" });

    expect(db.messages()).toEqual([]);
    expect(db.rows()[0].status).toBe(RequestStatus.PENDING);
  });

  it("still refuses while the existing request is pending", async () => {
    // The reopen path must not weaken the guard it sits behind.
    const db = buildRequestsDb([requestRow("live", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "again" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

/**
 * A request is how you ask to share a carpool, so it makes no sense between two
 * people already sharing one — and it would be a second, contradictable record
 * of a relationship the group already holds (SCRUM-228).
 */
describe("user.requests.create — not while already carpooling together", () => {
  it("refuses when both users are in the same group", async () => {
    const db = buildRequestsDb([], {
      [USER_A]: "group-1",
      [USER_B]: "group-1",
    });
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.create).not.toHaveBeenCalled();
  });

  it("refuses to reopen an accepted request between current group members", async () => {
    const db = buildRequestsDb(
      [
        requestRow("old", USER_A, USER_B, {
          status: RequestStatus.ACCEPTED,
          conversationId: "conversation-old",
        }),
      ],
      { [USER_A]: "group-1", [USER_B]: "group-1" },
    );
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.rows()[0].status).toBe(RequestStatus.ACCEPTED);
  });

  it("allows a request between users in different groups", async () => {
    const db = buildRequestsDb([], {
      [USER_A]: "group-1",
      [USER_B]: "group-2",
    });
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).resolves.toBeDefined();
  });

  it("allows a request when neither user is in a group", async () => {
    const db = buildRequestsDb([], { [USER_A]: null, [USER_B]: null });
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).resolves.toBeDefined();
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

/**
 * A request has to be notifiable (SCRUM-292).
 *
 * ConnectModal used to hold this check on its own, reading `otherUser.email`
 * from the recommendation payload. That payload no longer carries the field -
 * it was shipping every active user's Northeastern address to every signed-in
 * viewer - and a client-only check was skipped entirely by anything calling the
 * procedure directly. The rule lives here now.
 */
describe("user.requests.create — both people must be reachable (SCRUM-292)", () => {
  it("refuses when the recipient has no email, writing nothing", async () => {
    const { caller, db } = callerFor(
      sessionFor(USER_A),
      buildRequestsDb([], {}, { [USER_B]: null }),
    );

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "Hello" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.rows()).toEqual([]);
  });

  it("refuses when the caller has no email", async () => {
    const { caller, db } = callerFor(
      sessionFor(USER_A),
      buildRequestsDb([], {}, { [USER_A]: null }),
    );

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "Hello" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.rows()).toEqual([]);
  });

  it("refuses when the recipient has no user row at all", async () => {
    // `findMany` returns nothing for an id that does not exist, so a missing
    // row and a missing address land in the same branch - which is right, since
    // neither can be emailed.
    const { caller, db } = callerFor(sessionFor(USER_A));
    (db.prisma as any).user.findMany.mockResolvedValueOnce([
      { id: USER_A, email: "a@northeastern.edu" },
    ]);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "Hello" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.rows()).toEqual([]);
  });

  it("allows the request when both addresses are present", async () => {
    const { caller, db } = callerFor(sessionFor(USER_A));

    await caller.user.requests.create({ toId: USER_B, message: "Hello" });

    expect(db.rows()).toHaveLength(1);
  });
});

/**
 * `user.requests.me` no longer role-filters an existing request (SCRUM-296).
 *
 * The filter it used to apply - counterpart's role must differ from the
 * caller's, and must not be VIEWER - is the recommendations predicate, and it
 * disagreed with `create`'s duplicate guard above, which has no role condition.
 * A role change on either side therefore removed the request from the Requests
 * tab while every retry still failed with `CONFLICT`. `delete` needs the
 * request id and nothing else surfaces one, so the pair were stuck until the
 * other person switched back.
 *
 * Read alongside "the duplicate guard still holds" above: that pins what
 * `create` does to a pending request whatever the two roles are, and these pin
 * the list that now shows the same request.
 */
const searchRow = (
  userId: string,
  role: Role,
  overrides: { status?: Status; carpoolId?: string | null } = {},
) => ({
  id: `search-${userId}`,
  userId,
  role,
  status: overrides.status ?? Status.ACTIVE,
  carpoolId: overrides.carpoolId ?? null,
  seatsAvail: role === Role.DRIVER ? 3 : 0,
  companyName: "Acme",
  daysWorking: "1,1,1,1,1,0,0",
  startTime: null,
  endTime: null,
  startDate: null,
  endDate: null,
  groupMessage: null,
  homeLocationId: null,
  companyLocationId: null,
  user: {
    id: userId,
    name: userId,
    email: `${userId}@northeastern.edu`,
    image: null,
    bio: "",
    preferredName: userId,
    pronouns: "",
  },
  homeLocation: null,
  companyLocation: null,
});

/**
 * A Prisma double for `me` alone. Separate from `buildRequestsDb` above on
 * purpose: `me` reads a shape - a user with both request relations, plus one
 * `CarpoolSearch` per party with its user and locations - that none of the
 * mutations touch, and folding both into one double would leave neither
 * readable.
 */
const buildRequestsMeDb = (
  seed: RequestRow[],
  roles: Record<string, Role>,
  statuses: Record<string, Status> = {},
) => {
  const searchFor = (userId: string) =>
    searchRow(userId, roles[userId] ?? Role.VIEWER, {
      status: statuses[userId],
    });

  const userFindUnique = jest.fn(async ({ where }: any) => ({
    id: where.id,
    sentRequests: seed
      .filter((row) => row.fromUserId === where.id)
      .map((row) => ({ ...row, conversation: null })),
    receivedRequests: seed
      .filter((row) => row.toUserId === where.id)
      .map((row) => ({ ...row, conversation: null })),
  }));

  const carpoolSearchFindFirst = jest.fn(async ({ where }: any) =>
    searchFor(where.userId),
  );

  const carpoolSearchFindMany = jest.fn(async ({ where }: any) => {
    const ids: string[] = where?.userId?.in ?? [];

    // `me` asks for `status: { not: "INACTIVE" }`, and the resolver's remaining
    // null check depends on that exclusion, so the double has to honour it.
    return ids
      .map(searchFor)
      .filter((search) => search.status !== Status.INACTIVE);
  });

  return {
    prisma: {
      user: { findUnique: userFindUnique },
      carpoolSearch: {
        findFirst: carpoolSearchFindFirst,
        findMany: carpoolSearchFindMany,
      },
    } as unknown as Context["prisma"],
    carpoolSearchFindMany,
  };
};

const meCallerFor = (
  userId: string,
  seed: RequestRow[],
  roles: Record<string, Role>,
  statuses: Record<string, Status> = {},
) => {
  const db = buildRequestsMeDb(seed, roles, statuses);
  const ctx = {
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db };
};

describe("user.requests.me - an existing request survives a role change", () => {
  it("returns a sent request to a counterpart who now shares the caller's role", async () => {
    // The ticket's scenario: rider A asked driver B, then B switched to Rider.
    // Before this fix the request vanished from A's tab while `create` kept
    // answering `CONFLICT - Existing request between ...`.
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.RIDER },
    );

    const result = await caller.user.requests.me();

    expect(result.received).toEqual([]);
    expect(result.sent).toEqual([
      expect.objectContaining({
        id: "request-1",
        toUser: expect.objectContaining({ id: USER_B, role: Role.RIDER }),
      }),
    ]);
  });

  it("returns a received request from a counterpart who now shares the caller's role", async () => {
    const { caller } = meCallerFor(
      USER_B,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.RIDER },
    );

    const result = await caller.user.requests.me();

    expect(result.sent).toEqual([]);
    expect(result.received).toEqual([
      expect.objectContaining({
        id: "request-1",
        fromUser: expect.objectContaining({ id: USER_A, role: Role.RIDER }),
      }),
    ]);
  });

  it("keeps both directions when two drivers are left facing each other", async () => {
    const { caller } = meCallerFor(
      USER_A,
      [
        requestRow("request-1", USER_A, USER_B),
        requestRow("request-2", USER_C, USER_A),
      ],
      { [USER_A]: Role.DRIVER, [USER_B]: Role.DRIVER, [USER_C]: Role.DRIVER },
    );

    const result = await caller.user.requests.me();

    expect(result.sent.map((req) => req.id)).toEqual(["request-1"]);
    expect(result.received.map((req) => req.id)).toEqual(["request-2"]);
  });

  it("returns a request whose counterpart has switched to VIEWER", async () => {
    // Also filtered out before, and the same dead end: a VIEWER cannot answer
    // the request, so leaving the sender no way to withdraw it stranded both.
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.VIEWER },
    );

    const result = await caller.user.requests.me();

    expect(result.sent.map((req) => req.id)).toEqual(["request-1"]);
  });

  it("still returns the ordinary compatible pair", async () => {
    // The regression guard for this change: unfiltering must not disturb the
    // case that always worked.
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
    );

    const result = await caller.user.requests.me();

    expect(result.sent.map((req) => req.id)).toEqual(["request-1"]);
  });

  it("returns an accepted request as well, whatever the two roles are", async () => {
    // Accepted requests stay attached to the pair so they keep their
    // conversation (SCRUM-228); the role filter used to take those with it.
    const { caller } = meCallerFor(
      USER_A,
      [
        requestRow("request-1", USER_A, USER_B, {
          status: RequestStatus.ACCEPTED,
        }),
      ],
      { [USER_A]: Role.RIDER, [USER_B]: Role.RIDER },
    );

    const result = await caller.user.requests.me();

    expect(result.sent).toEqual([
      expect.objectContaining({
        id: "request-1",
        status: RequestStatus.ACCEPTED,
      }),
    ]);
  });

  it("still drops a request whose counterpart has no active search", async () => {
    // The one filter that remains, and it is not about roles: an INACTIVE
    // counterpart is absent from the `CarpoolSearch` query, so there is no
    // `PublicUser` to build a card from. Pinned so that removing the role
    // predicate is not read as removing this too.
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
      { [USER_B]: Status.INACTIVE },
    );

    const result = await caller.user.requests.me();

    expect(result.sent).toEqual([]);
  });

  it("never asks the database to filter by role either", async () => {
    // The predicate is gone from the resolver, so it must not reappear as a
    // `where` clause: that is the form it took in `getUnreadMessageCount`, and
    // both had to go for the list and the badge to agree.
    const { caller, db } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.RIDER },
    );

    await caller.user.requests.me();

    for (const call of db.carpoolSearchFindMany.mock.calls) {
      expect(JSON.stringify(call[0]?.where ?? {})).not.toContain("role");
    }
  });
});
