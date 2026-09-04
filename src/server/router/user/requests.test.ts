import { Permission, RequestStatus, Role, Status } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";
import { MESSAGE_MAX_LENGTH } from "../../../utils/textLimits";
import { cloneState, withTransaction } from "../transactionMock";

/**
 * Authorization tests for the `user.requests` router.
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
 * stand-in for a database, not a substitute for one.
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
   * userId -> email, for the notifiability guard. Everyone has one
   * unless a test says otherwise, because that is the ordinary case: the field
   * comes from Azure AD at sign-in.
   */
  emails: Record<string, string | null> = {},
  /**
   * userId -> seatsAvail. `create` deliberately does not read this — see the
   * SCRUM-361 block at the bottom of this file — so it exists only so that
   * absence can be asserted rather than assumed. Last in the list, and
   * defaulted, because the parameters here are positional: inserting it
   * earlier silently turned two `emails` arguments into seat counts.
   */
  seats: Record<string, number> = {},
) => {
  const requests = new Map<string, RequestRow>(
    seed.map((row) => [row.id, { ...row }]),
  );

  // A seeded request that claims a conversation gets one, so that
  // `conversation.findUnique({ where: { requestId } })` can find it. Without
  // this the map started empty and the lookup missed for a request whose
  // `conversationId` was set — which would make the SCRUM-350 tests below pass
  // for the wrong reason, reporting a repaired link where the real database
  // would have found the conversation already there.
  const conversations = new Map<string, { id: string; requestId: string }>(
    seed
      .filter((row) => row.conversationId !== null)
      .map((row) => [
        row.conversationId as string,
        { id: row.conversationId as string, requestId: row.id },
      ]),
  );
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
      seatsAvail: seats[userId] ?? 3,
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
    // nested create, so the mock has to honour the nested form or
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

  /**
   * `requests.delete` removes the conversation with the request.
   *
   * Two deliberate choices, because a friendlier mock would hide the bugs it
   * exists to catch:
   *
   *   - **A key present with value `undefined` matches everything**, which is
   *     what real Prisma does and why `conversationsToDeleteWith` never emits
   *     `{ id: undefined }`. A mock that treated it as "matches nothing" would
   *     let a delete-the-whole-table filter pass as a delete of one row.
   *   - **Nothing here cascades.** Prisma emulates `onDelete: Cascade` under
   *     `relationMode = "prisma"`, but a mock that emulated it too would make
   *     "the messages were deleted" a fact about the mock rather than about
   *     the router. So messages survive unless the router deletes them itself,
   *     which is what the assertions then check.
   */
  const matchesConversationFilter = (
    filter: any,
    row: { id: string; requestId: string },
  ) => {
    const keys = Object.keys(filter);
    if (keys.length === 0) return true;
    return keys.every((key) => {
      const expected = filter[key];
      if (expected === undefined) return true;
      if (expected && typeof expected === "object" && "in" in expected) {
        return (expected.in as string[]).includes(
          (row as Record<string, string>)[key],
        );
      }
      return (row as Record<string, string>)[key] === expected;
    });
  };

  const conversationFindMany = jest.fn(async ({ where }: any) => {
    const filters: any[] = where?.OR ?? [where ?? {}];
    return [...conversations.values()]
      .filter((row) => filters.some((f) => matchesConversationFilter(f, row)))
      .map((row) => ({ ...row }));
  });

  const conversationDeleteMany = jest.fn(async ({ where }: any) => {
    const filters: any[] = where?.OR ?? [where ?? {}];
    const doomed = [...conversations.values()].filter((row) =>
      filters.some((f) => matchesConversationFilter(f, row)),
    );
    for (const row of doomed) conversations.delete(row.id);
    return { count: doomed.length };
  });

  const messageDeleteMany = jest.fn(async ({ where }: any) => {
    const ids: string[] = where?.conversationId?.in ?? [];
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (ids.includes(messages[i].conversationId)) {
        messages.splice(i, 1);
        count++;
      }
    }
    return { count };
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
  // notified.
  const userFindMany = jest.fn(async ({ where }: any) => {
    const ids: string[] = where?.id?.in ?? [];
    return ids.map((id) => ({
      id,
      email: id in emails ? emails[id] : `${id}@northeastern.edu`,
    }));
  });

  // `requests.create` commits its four writes as one transaction,
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
        findMany: conversationFindMany,
        create: conversationCreate,
        deleteMany: conversationDeleteMany,
      },
      message: { create: messageCreate, deleteMany: messageDeleteMany },
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
    /** Conversation rows, for asserting the `Conversation.requestId` side. */
    conversations: () => [...conversations.values()],
    create,
    destroy,
    update,
    conversationCreate,
    conversationDeleteMany,
    messageDeleteMany,
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
 * SCRUM-349: a double-clicked Send must not build the pair two of everything.
 *
 * The duplicate-guard tests above all *seed* an existing row, so they prove the
 * guard reads correctly — but none of them ever ran `create` twice, which is
 * the sequence a double-click actually produces and the one the defect lived
 * in. The lookup used to happen outside any transaction, so two calls could
 * both find nothing and both take the create branch, leaving two `Request`
 * rows, two `Conversation`s, two first `Message`s and two notification emails.
 *
 * The end state was worse than untidy: withdrawing deleted one row by id and
 * left the other, so the next attempt was refused with CONFLICT for a request
 * neither party could see — unrecoverable through the UI.
 *
 * These run the real sequence. What they cannot show is the concurrency: the
 * mock is single-threaded, so the second call always observes the first. That
 * is a genuine limit rather than an oversight — moving the read inside the
 * transaction narrows the window but does not close it, because MySQL will not
 * lock rows a non-locking SELECT did not find. The control that removes the
 * realistic path is the in-flight guard on `ConnectModal`'s Send button, which
 * has no component test in this repository to pin it. See "One request per
 * pair" in `src/server/db/README.md` for why no unique constraint was added.
 */
describe("user.requests.create — pressing Send twice", () => {
  const SENT = { toId: USER_B, message: "carpool?" };

  /** The state after the first click has landed. */
  const afterFirstClick = async () => {
    const db = buildRequestsDb();
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create(SENT);

    return { db, caller };
  };

  it("refuses the second click", async () => {
    const { caller } = await afterFirstClick();

    await expect(caller.user.requests.create(SENT)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("leaves exactly one request between the pair", async () => {
    const { db, caller } = await afterFirstClick();

    await expect(caller.user.requests.create(SENT)).rejects.toBeInstanceOf(
      TRPCError,
    );

    expect(db.rows()).toEqual([
      expect.objectContaining({ fromUserId: USER_A, toUserId: USER_B }),
    ]);
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("writes one opening message, not two", async () => {
    // The duplicate conversation is what actually stranded a message:
    // `extendPublicUser` resolves a user's request with `.find()`, so only one
    // of the two threads was ever reachable from the UI. A second message here
    // would mean a second conversation had been built.
    const { db, caller } = await afterFirstClick();

    await expect(caller.user.requests.create(SENT)).rejects.toBeInstanceOf(
      TRPCError,
    );

    expect(db.messages()).toEqual([
      expect.objectContaining({ content: "carpool?", userId: USER_A }),
    ]);
  });

  it("still refuses when the two clicks arrive in opposite directions", async () => {
    // Two people pressing Connect on each other at once. The guard is
    // direction-agnostic, so the second is refused whichever way it points.
    const { db } = await afterFirstClick();
    const { caller: other } = callerFor(sessionFor(USER_B), db);

    await expect(
      other.user.requests.create({ toId: USER_A, message: "you too?" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(db.rows()).toHaveLength(1);
  });
});

/**
 * Reopening an accepted request.
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
 * SCRUM-350: reopening a request with no conversation used to destroy the
 * message.
 *
 * The reopen branch wrote the message only `if (input.message &&
 * reopened.conversationId)`. Those are two unrelated conditions sharing one
 * guard, and the second one was wrong: a request with a null link had the
 * user's text dropped while the mutation still resolved. `ConnectModal` then
 * raised its success toast and emailed the recipient a `messagePreview` of a
 * message that had never been stored, so the recipient opened an empty thread
 * holding an email that quoted it.
 *
 * Not a guard against an impossible state: `Conversation` arrived in migration
 * `20240910182030_conversationmodel`, and every older request has
 * `conversationId = NULL` — 462 of 477 rows on production-derived staging.
 * Reaching the branch also needs `status = ACCEPTED`, which
 * `scripts/backfill-request-status.ts` grants in bulk and has not yet been run
 * in production.
 *
 * The four combinations below are {null link, existing link} × {empty message,
 * non-empty message}. Only two of them had coverage before.
 */
describe("user.requests.create — reopening repairs a missing conversation", () => {
  /** An accepted legacy request: no conversation, as 462 rows have. */
  const legacy = (id: string, from: string, to: string) =>
    requestRow(id, from, to, {
      status: RequestStatus.ACCEPTED,
      conversationId: null,
    });

  const linked = (id: string, from: string, to: string) =>
    requestRow(id, from, to, {
      status: RequestStatus.ACCEPTED,
      conversationId: `conversation-${id}`,
    });

  it("stores the message instead of discarding it", async () => {
    // The regression this ticket exists for.
    const db = buildRequestsDb([legacy("legacy", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({
      toId: USER_B,
      message: "want to carpool again this semester?",
    });

    expect(db.messages()).toEqual([
      {
        conversationId: "conversation-legacy",
        content: "want to carpool again this semester?",
        userId: USER_A,
      },
    ]);
  });

  it("writes both sides of the link, which nothing in the schema keeps in agreement", async () => {
    const db = buildRequestsDb([legacy("legacy", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    // `Conversation.requestId` — the authoritative side.
    expect(db.conversations()).toEqual([
      { id: "conversation-legacy", requestId: "legacy" },
    ]);
    // `Request.conversationId` — the side `user.requests.me` reads through.
    expect(db.rows()[0]?.conversationId).toBe("conversation-legacy");
  });

  it("returns a request carrying the conversation it just linked", async () => {
    // `reopened` is read before the repair, so returning it unchanged would
    // report null for a conversation that now exists.
    const db = buildRequestsDb([legacy("legacy", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).resolves.toMatchObject({
      status: RequestStatus.PENDING,
      conversationId: "conversation-legacy",
    });
  });

  it("creates no conversation when a legacy request is reopened with no message", async () => {
    // A null link is a legitimate state, so an empty reopen should not
    // manufacture a thread nobody has written to. `messages.conversation`
    // already treats a missing conversation as an empty first page.
    const db = buildRequestsDb([legacy("legacy", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "" });

    expect(db.messages()).toEqual([]);
    expect(db.conversations()).toEqual([]);
    expect(db.conversationCreate).not.toHaveBeenCalled();
    expect(db.rows()[0]).toMatchObject({
      status: RequestStatus.PENDING,
      conversationId: null,
    });
  });

  it("appends to an existing conversation without creating a second one", async () => {
    const db = buildRequestsDb([linked("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "round two" });

    expect(db.conversationCreate).not.toHaveBeenCalled();
    expect(db.conversations()).toEqual([
      { id: "conversation-old", requestId: "old" },
    ]);
    expect(db.messages()).toEqual([
      {
        conversationId: "conversation-old",
        content: "round two",
        userId: USER_A,
      },
    ]);
  });

  it("writes nothing to an existing conversation for an empty message", async () => {
    const db = buildRequestsDb([linked("old", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "" });

    expect(db.messages()).toEqual([]);
    expect(db.conversationCreate).not.toHaveBeenCalled();
  });

  it("reuses a conversation the request row does not know about", async () => {
    // The two sides of the link can disagree, because only
    // `Conversation.requestId` is unique and nothing enforces agreement. The
    // lookup is keyed on that side for exactly this case: keying on the
    // request row would try to create a second conversation for the same
    // `requestId` and hit the unique constraint.
    const db = buildRequestsDb([legacy("legacy", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    // An orphan conversation: present, but never linked back to the request.
    await db.prisma.conversation.create({ data: { requestId: "legacy" } });
    db.conversationCreate.mockClear();

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.conversationCreate).not.toHaveBeenCalled();
    expect(db.conversations()).toHaveLength(1);
    expect(db.messages()).toEqual([
      {
        conversationId: "conversation-legacy",
        content: "hello",
        userId: USER_A,
      },
    ]);
  });

  it("leaves no conversation or message behind when the message write fails", async () => {
    // The repair is two statements and the message a third. Untransactioned,
    // this failure would leave a conversation linked to a request with no
    // message in it — the half-built thread the create path was already
    // careful about.
    const db = buildRequestsDb([legacy("legacy", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    db.prisma.message.create.mockImplementationOnce(async () => {
      throw new Error("connection lost");
    });

    await expect(
      caller.user.requests.create({ toId: USER_B, message: "hello" }),
    ).rejects.toThrow("connection lost");

    expect(db.conversations()).toEqual([]);
    expect(db.messages()).toEqual([]);
    // The reopen itself is rolled back too, so the row is untouched.
    expect(db.rows()[0]).toMatchObject({
      status: RequestStatus.ACCEPTED,
      conversationId: null,
    });
  });
});

/**
 * A request is how you ask to share a carpool, so it makes no sense between two
 * people already sharing one — and it would be a second, contradictable record
 * of a relationship the group already holds.
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
   * The UI never produces this — ConnectModal opens from someone
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

describe("user.requests.create — the opening message is bounded", () => {
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
 * Atomicity of `user.requests.create`.
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
 * A request has to be notifiable.
 *
 * ConnectModal used to hold this check on its own, reading `otherUser.email`
 * from the recommendation payload. That payload no longer carries the field -
 * it was shipping every active user's Northeastern address to every signed-in
 * viewer - and a client-only check was skipped entirely by anything calling the
 * procedure directly. The rule lives here now.
 */
describe("user.requests.create — both people must be reachable", () => {
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
 * `user.requests.me` no longer role-filters an existing request.
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
/**
 * A home `Location` for the SCRUM-368 tests, which are the only ones that care
 * where anybody lives.
 *
 * Five decimal places deliberately, so that coarsening to two is unmistakable
 * rather than a rounding coincidence.
 */
const homeLocationAt = (
  userId: string,
  coords: { coordLng: number; coordLat: number },
) => ({
  id: `home-${userId}`,
  city: "Somerville",
  state: "MA",
  street: "Highland Ave",
  streetAddress: `12 Highland Ave`,
  coordLng: coords.coordLng,
  coordLat: coords.coordLat,
  dateCreated: new Date(2024, 0, 1),
  dateModified: new Date(2024, 0, 1),
});

const searchRow = (
  userId: string,
  role: Role,
  overrides: {
    status?: Status;
    carpoolId?: string | null;
    /**
     * Left null by default, which is what every test predating SCRUM-368
     * expects: they assert on which requests come back, never on where their
     * counterparts live.
     */
    home?: { coordLng: number; coordLat: number } | null;
  } = {},
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
  homeLocationId: overrides.home ? `home-${userId}` : null,
  companyLocationId: null,
  // Every row carries an address, because `me`'s counterpart queries select the
  // column: the coarsened path has to be shown dropping an email that is
  // genuinely present, not one that was never there.
  user: {
    id: userId,
    name: userId,
    email: `${userId}@northeastern.edu`,
    image: null,
    bio: "",
    preferredName: userId,
    pronouns: "",
  },
  homeLocation: overrides.home ? homeLocationAt(userId, overrides.home) : null,
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
  /**
   * userId -> home coordinate, for the SCRUM-368 disclosure tests. Last in the
   * list and defaulted for the reason `buildRequestsDb` records above: these
   * parameters are positional, so a new one inserted earlier silently reads
   * some other test's argument.
   */
  homes: Record<string, { coordLng: number; coordLat: number }> = {},
  /**
   * Users with no `CarpoolSearch` row at all — someone who never finished
   * onboarding. Distinct from an INACTIVE search, and after SCRUM-369 the only
   * thing the resolver's null checks still cover. Positional and last, for the
   * reason recorded above.
   */
  missingSearches: string[] = [],
) => {
  const searchFor = (userId: string) =>
    missingSearches.includes(userId)
      ? null
      : searchRow(userId, roles[userId] ?? Role.VIEWER, {
          status: statuses[userId],
          home: homes[userId],
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

    // Applies whatever status condition the query actually carries, rather
    // than a hard-coded one. It used to exclude INACTIVE unconditionally,
    // mirroring the `status: { not: "INACTIVE" }` the resolver then had — which
    // meant the double produced the filtered result whether or not the query
    // asked for it, and SCRUM-369's removal of that filter would have passed
    // every test in this file unnoticed.
    const excluded: Status | undefined = where?.status?.not;

    return ids
      .map(searchFor)
      .filter(
        (search): search is NonNullable<typeof search> =>
          search !== null &&
          (excluded === undefined || search.status !== excluded),
      );
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
    userFindUnique,
  };
};

const meCallerFor = (
  userId: string,
  seed: RequestRow[],
  roles: Record<string, Role>,
  statuses: Record<string, Status> = {},
  homes: Record<string, { coordLng: number; coordLat: number }> = {},
  missingSearches: string[] = [],
) => {
  const db = buildRequestsMeDb(seed, roles, statuses, homes, missingSearches);
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
    // conversation; the role filter used to take those with it.
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

  /**
   * This case used to assert the opposite — that an INACTIVE counterpart was
   * dropped — and was written to stop the role fix being read as covering
   * status too. SCRUM-369 established that it should never have been the
   * exception: pausing a search is something any user can do from their own
   * profile, and the moment either party did, the request vanished from both
   * Requests tabs while `create`'s duplicate guard went on refusing every
   * retry with CONFLICT. Neither party could withdraw it, decline it or
   * replace it until the other reactivated. It is the same dead end SCRUM-296
   * closed for roles, one filter away in the same function.
   */
  it("returns a sent request whose counterpart has paused their search", async () => {
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
      { [USER_B]: Status.INACTIVE },
    );

    const result = await caller.user.requests.me();

    expect(result.sent).toEqual([
      expect.objectContaining({
        id: "request-1",
        toUser: expect.objectContaining({
          id: USER_B,
          status: Status.INACTIVE,
        }),
      }),
    ]);
  });

  it("returns a received request whose counterpart has paused their search", async () => {
    // The other direction. The recipient has the same dead end as the sender:
    // no card means no way to decline.
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_B, USER_A)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
      { [USER_B]: Status.INACTIVE },
    );

    const result = await caller.user.requests.me();

    expect(result.received).toEqual([
      expect.objectContaining({
        id: "request-1",
        fromUser: expect.objectContaining({
          id: USER_B,
          status: Status.INACTIVE,
        }),
      }),
    ]);
  });

  it("never asks the database to filter by status either", async () => {
    // The `where` form of the same predicate, pinned for the reason the role
    // case below is: the filter has to be gone from the query, not merely from
    // the resolver, or the counterpart never arrives to be projected.
    const { caller, db } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
      { [USER_B]: Status.INACTIVE },
    );

    await caller.user.requests.me();

    for (const call of db.carpoolSearchFindMany.mock.calls) {
      expect(JSON.stringify(call[0]?.where ?? {})).not.toContain("status");
    }
  });

  it("still drops a request whose counterpart never onboarded", async () => {
    // What the resolver's null checks cover now, and all they cover: a
    // counterpart with no `CarpoolSearch` row at all. That is a genuine
    // absence — there is no `PublicUser` to build a card from — rather than a
    // row deliberately hidden from the query.
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
      {},
      {},
      [USER_B],
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

/**
 * What `me` asks the database for.
 *
 * These assert on the Prisma arguments rather than on the result, because the
 * result cannot catch this class of regression and neither can the compiler:
 * `extendPublicUser` in `pages/index.tsx` casts request rows through `as any`,
 * so a widened `include` type-checks and a narrowed one does too. The payload
 * shape is only observable here.
 *
 * Three things are pinned:
 *
 *  1. No `User` on messages. It attached the author's whole row - `email`,
 *     `bio`, `image` as `@db.MediumText` - to every message, and the author is
 *     always one of the two people already in the payload, so a 60-message
 *     thread carried the same two rows 60 times.
 *  2. No `toUser`/`fromUser`. Both were fetched and then overwritten by the
 *     `...req` spread, so they were read and discarded.
 *  3. The six message columns that *are* read stay selected. Narrowing too far
 *     is the opposite failure and just as invisible: dropping `isRead` or `id`
 *     would silently break `markMessagesAsRead`.
 */
describe("user.requests.me - what it asks the database for", () => {
  const includeArg = async () => {
    const { caller, db } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER },
    );

    await caller.user.requests.me();

    expect(db.userFindUnique).toHaveBeenCalledTimes(1);
    return db.userFindUnique.mock.calls[0]![0].include;
  };

  it("never joins the author row onto a message", async () => {
    const include = await includeArg();

    for (const side of ["sentRequests", "receivedRequests"] as const) {
      const messages = include[side].include.conversation.include.messages;

      expect(messages.include).toBeUndefined();
      expect(messages.select).not.toHaveProperty("User");
    }
  });

  it("never joins the counterpart, which the spread overwrites anyway", async () => {
    const include = await includeArg();

    expect(include.sentRequests.include).not.toHaveProperty("toUser");
    expect(include.receivedRequests.include).not.toHaveProperty("fromUser");
  });

  it("selects exactly the message columns the UI reads", async () => {
    // Named individually so a failure says which column moved. `isRead` and
    // `id` drive `markMessagesAsRead`; `content`, `userId` and `dateCreated`
    // drive the thread and the card previews; `conversationId` satisfies the
    // declared `Message` type.
    const include = await includeArg();

    for (const side of ["sentRequests", "receivedRequests"] as const) {
      const messages = include[side].include.conversation.include.messages;

      expect(Object.keys(messages.select).sort()).toEqual([
        "content",
        "conversationId",
        "dateCreated",
        "id",
        "isRead",
        "userId",
      ]);
    }
  });

  it("asks for the newest message only, not the thread", async () => {
    // This asserted `{ dateCreated: "asc" }` and no `take`, on the grounds that
    // "the renderer depends on it". The renderer no longer reads this payload:
    // `MessageContent` loads the open thread from
    // `user.messages.conversation`, which is paginated and participant-scoped.
    //
    // What is left reading these messages is the card list, and it wants one
    // row — the newest, for the preview text and the unread dot. `desc` is
    // load-bearing rather than cosmetic: with `take: 1`, `asc` would keep the
    // *oldest* message and every card would preview the first thing ever said.
    const include = await includeArg();

    for (const side of ["sentRequests", "receivedRequests"] as const) {
      const messages = include[side].include.conversation.include.messages;

      expect(messages.orderBy).toEqual({ dateCreated: "desc" });
      expect(messages.take).toBe(1);
    }
  });

  it("bounds the payload so it cannot grow with message history", async () => {
    // The property that matters, stated independently of how it is achieved: a
    // pair with 500 messages must not transfer 500 rows to render one card.
    const include = await includeArg();

    for (const side of ["sentRequests", "receivedRequests"] as const) {
      const messages = include[side].include.conversation.include.messages;

      expect(typeof messages.take).toBe("number");
      expect(messages.take).toBeLessThanOrEqual(1);
    }
  });

  it("joins no user relation anywhere under the request includes", async () => {
    // A catch-all over relation *names*, because that is what an `include`
    // actually contains - a Prisma join names the relation, never the columns,
    // so asserting on "email" or "image" here would pass against the very shape
    // this replaces. `User`, `toUser` and `fromUser` are the three routes a full
    // `user` row can re-enter this payload by; `user` covers a renamed one.
    const include = await includeArg();

    for (const relation of ["User", "toUser", "fromUser", "user"]) {
      expect(JSON.stringify(include)).not.toContain(`"${relation}"`);
    }
  });
});

/**
 * SCRUM-361: the server stays permissive, deliberately.
 *
 * A rider could reach a full driver's card through favourites or a stale list
 * and send a request `reserveSeat` would refuse at every acceptance. The fix
 * refuses at the card — `connectAction` and the card's own notice — and
 * leaves this mutation alone.
 *
 * That was a decision, not an omission, and these tests are where it is
 * recorded. Two reasons for it:
 *
 *   - A request to a currently-full driver is not meaningless. Seats free up,
 *     and the request becomes acceptable with nothing further needed. Refusing
 *     here would remove that rather than fix anything.
 *   - Requests already sent to a full driver cannot be helped by a guard on
 *     `create`. They are addressed by the driver-side copy in
 *     `requestHandlers`, which now says the request is still theirs to accept.
 *
 * If a future change makes this fail, that is the point: the seat check moving
 * server-side needs the queueing question answered first, not answered by
 * accident.
 */
describe("user.requests.create — a full driver is not refused here", () => {
  it("writes the request even when the recipient has no seats free", async () => {
    const db = buildRequestsDb([], {}, {}, { [USER_B]: 0 });
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.create).toHaveBeenCalled();
  });

  it("writes it for a negative count too", async () => {
    // The SCRUM-348 row. Uniform with 0 here, as everywhere else.
    const db = buildRequestsDb([], {}, {}, { [USER_B]: -1 });
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "hello" });

    expect(db.create).toHaveBeenCalled();
  });

  it("reopens an accepted request against a full driver, as it would any other", async () => {
    // The pair carpooled before and want to again. The driver being full now
    // is a reason to wait, not a reason to refuse the reopen.
    const db = buildRequestsDb(
      [
        requestRow("old", USER_A, USER_B, {
          status: RequestStatus.ACCEPTED,
          conversationId: "conversation-old",
        }),
      ],
      {},
      {},
      { [USER_B]: 0 },
    );
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.create({ toId: USER_B, message: "again?" });

    expect(db.rows()).toHaveLength(1);
    expect(db.rows()[0]).toMatchObject({
      id: "old",
      status: RequestStatus.PENDING,
      fromUserId: USER_A,
      toUserId: USER_B,
    });
    expect(db.create).not.toHaveBeenCalled();
  });
});

/**
 * The cascade in the schema points the other way — `Request` holds the foreign
 * key, so `onDelete: Cascade` runs Conversation → Request — and nothing ran
 * Request → Conversation. Every decline, withdrawal and "Leave Conversation"
 * therefore left a `conversation` row and its `message` rows behind, with
 * `Conversation.requestId` dangling at a row that no longer existed. 11 of
 * them holding 25 real messages on production-derived staging.
 *
 * Deleting rather than preserving was the decision, because the thread is
 * unreachable the instant the request row goes: `getConversationMessages`
 * throws NOT_FOUND without a request, and the unread count joins through
 * `conversation.request.some(...)`. What persisted was private message content
 * with no route to it and no deletion path.
 */
describe("user.requests.delete — the conversation goes with it", () => {
  /** The invariant, stated once: no conversation may outlive its request. */
  const expectNoDanglingConversation = (db: {
    rows: () => { id: string }[];
    conversations: () => { id: string; requestId: string }[];
  }) => {
    const liveRequestIds = new Set(db.rows().map((row) => row.id));
    for (const conversation of db.conversations()) {
      expect(liveRequestIds.has(conversation.requestId)).toBe(true);
    }
  };

  it("deletes the conversation attached to the request", async () => {
    const db = buildRequestsDb([
      requestRow("req-1", USER_A, USER_B, {
        conversationId: "conversation-req-1",
      }),
    ]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    expect(db.conversations()).toHaveLength(1);

    await caller.user.requests.delete({ invitationId: "req-1" });

    expect(db.rows()).toEqual([]);
    expect(db.conversations()).toEqual([]);
    expectNoDanglingConversation(db);
  });

  it("deletes the messages itself, not by relying on the cascade", async () => {
    // Built through the real create path so the message is written the way the
    // application writes it, rather than seeded into the mock by hand.
    const db = buildRequestsDb();
    const { caller } = callerFor(sessionFor(USER_A), db);

    const created = await caller.user.requests.create({
      toId: USER_B,
      message: "are you still driving?",
    });

    expect(db.messages()).toHaveLength(1);

    await caller.user.requests.delete({ invitationId: created.id });

    expect(db.conversations()).toEqual([]);
    expect(db.messages()).toEqual([]);
  });

  it("succeeds for a request that never had a conversation", async () => {
    // 462 of 477 rows on staging predate the Conversation model. `delete`
    // would have thrown NOT_FOUND for these, which is why the mutation uses
    // `deleteMany`.
    const db = buildRequestsDb([requestRow("req-1", USER_A, USER_B)]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.delete({ invitationId: "req-1" }),
    ).resolves.not.toThrow();

    expect(db.rows()).toEqual([]);
  });

  it("leaves another pair's conversation alone", async () => {
    // The assertion the mock is built to be able to fail: a filter of
    // `{ id: undefined }` matches every row in real Prisma, so a delete that
    // was meant to remove one conversation would empty the table.
    const db = buildRequestsDb([
      requestRow("req-1", USER_A, USER_B, {
        conversationId: "conversation-req-1",
      }),
      requestRow("req-2", USER_B, USER_C, {
        conversationId: "conversation-req-2",
      }),
    ]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.delete({ invitationId: "req-1" });

    expect(db.conversations()).toEqual([
      { id: "conversation-req-2", requestId: "req-2" },
    ]);
    expectNoDanglingConversation(db);
  });

  it("removes a conversation reachable only through Request.conversationId", async () => {
    // The two links can disagree — nothing in the schema keeps them in
    // agreement, which is the whole reason `conversationLink.ts` exists. A
    // delete keyed only on `Conversation.requestId` would leave this behind.
    const db = buildRequestsDb([
      requestRow("req-1", USER_A, USER_B, {
        conversationId: "conversation-stale",
      }),
    ]);
    const { caller } = callerFor(sessionFor(USER_A), db);

    await caller.user.requests.delete({ invitationId: "req-1" });

    expect(db.conversations()).toEqual([]);
  });

  it("does not delete a conversation when the caller is refused", async () => {
    // Authorization runs before either delete, so a stranger's attempt must
    // leave both rows exactly as they were.
    const db = buildRequestsDb([
      requestRow("req-1", USER_A, USER_B, {
        conversationId: "conversation-req-1",
      }),
    ]);
    const { caller } = callerFor(sessionFor(USER_C), db);

    await expect(
      caller.user.requests.delete({ invitationId: "req-1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(db.rows()).toHaveLength(1);
    expect(db.conversations()).toHaveLength(1);
  });

  it("rolls the request delete back if the conversation delete fails", async () => {
    // Both writes commit together or neither does. A half-applied delete is
    // exactly the orphan this ticket is about, so the transaction is the fix
    // rather than an ordering detail.
    const db = buildRequestsDb([
      requestRow("req-1", USER_A, USER_B, {
        conversationId: "conversation-req-1",
      }),
    ]);
    db.conversationDeleteMany.mockRejectedValueOnce(new Error("boom"));
    const { caller } = callerFor(sessionFor(USER_A), db);

    await expect(
      caller.user.requests.delete({ invitationId: "req-1" }),
    ).rejects.toThrow();

    expect(db.rows()).toHaveLength(1);
    expect(db.conversations()).toHaveLength(1);
  });
});

/**
 * SCRUM-368 — what `requests.me` discloses about the *other* person.
 *
 * Both counterpart projections used the exact-home converter unconditionally,
 * so a request the caller had created a moment earlier released that person's
 * precise home coordinate and Northeastern address. `requests.create` takes a
 * bare `toId` and asks the recipient nothing, so the viewer could manufacture
 * the very relationship that authorised the disclosure — and doing it once per
 * id out of `mapbox.geoJsonUserList` walked the whole matchable user base.
 *
 * These pin the rule per request row. `convertRequestCounterpart` in
 * `publicUser.test.ts` covers the decision itself; these cover the procedure
 * applying it to the right half of each pair.
 *
 * Read alongside "an existing request survives a role change" above: that pins
 * which requests are returned, and SCRUM-296 and SCRUM-316 both closed dead
 * ends caused by requests disappearing from this list. Nothing here removes a
 * request — the fix narrows disclosure, never visibility.
 */
const EXACT_HOME = { coordLng: -71.08874812, coordLat: 42.33907341 };
const COARSE_HOME = { coordLng: -71.09, coordLat: 42.34 };

/** Both parties are real, matchable users who live somewhere. */
const BOTH_AT_HOME = { [USER_A]: EXACT_HOME, [USER_B]: EXACT_HOME };
const RIDER_AND_DRIVER = { [USER_A]: Role.RIDER, [USER_B]: Role.DRIVER };

describe("user.requests.me - a pending request discloses nothing extra", () => {
  it("coarsens the recipient's home coordinate for the sender", async () => {
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    );

    const result = await caller.user.requests.me();

    expect(result.sent[0]!.toUser!.startCoordLng).toBe(COARSE_HOME.coordLng);
    expect(result.sent[0]!.toUser!.startCoordLat).toBe(COARSE_HOME.coordLat);
  });

  it("withholds the recipient's email from the sender", async () => {
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    );

    const result = await caller.user.requests.me();

    expect(result.sent[0]!.toUser).not.toHaveProperty("email");
  });

  it("tells the recipient no more about the sender", async () => {
    // Deliberately symmetric. Being asked is better evidence than asking, but
    // it is still not agreement by the person whose home coordinate is at
    // stake, and nothing in the accept decision needs a doorstep.
    const { caller } = meCallerFor(
      USER_B,
      [requestRow("request-1", USER_A, USER_B)],
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    );

    const result = await caller.user.requests.me();

    expect(result.received[0]!.fromUser!.startCoordLat).toBe(
      COARSE_HOME.coordLat,
    );
    expect(result.received[0]!.fromUser).not.toHaveProperty("email");
  });

  it("still returns the request, with a counterpart to build a card from", async () => {
    const { caller } = meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    );

    const result = await caller.user.requests.me();

    expect(result.sent.map((req) => req.id)).toEqual(["request-1"]);
    expect(result.sent[0]!.toUser).not.toBeNull();
  });

  it("keeps the caller's own record exact on both sides", async () => {
    // The two converters decide what is disclosed about somebody else. The
    // caller's own coordinate and address are already theirs.
    const sender = await meCallerFor(
      USER_A,
      [requestRow("request-1", USER_A, USER_B)],
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    ).caller.user.requests.me();

    const recipient = await meCallerFor(
      USER_B,
      [requestRow("request-1", USER_A, USER_B)],
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    ).caller.user.requests.me();

    expect(sender.sent[0]!.fromUser.startCoordLng).toBe(EXACT_HOME.coordLng);
    expect(sender.sent[0]!.fromUser.email).toBe(`${USER_A}@northeastern.edu`);
    expect(recipient.received[0]!.toUser.startCoordLng).toBe(
      EXACT_HOME.coordLng,
    );
  });
});

describe("user.requests.me - an accepted request is mutual, and discloses both", () => {
  const accepted = [
    requestRow("request-1", USER_A, USER_B, {
      status: RequestStatus.ACCEPTED,
    }),
  ];

  it("gives the sender the recipient's exact coordinate and email", async () => {
    const { caller } = meCallerFor(
      USER_A,
      accepted,
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    );

    const result = await caller.user.requests.me();

    expect(result.sent[0]!.toUser!.startCoordLng).toBe(EXACT_HOME.coordLng);
    expect(result.sent[0]!.toUser!.startCoordLat).toBe(EXACT_HOME.coordLat);
    expect(result.sent[0]!.toUser!.email).toBe(`${USER_B}@northeastern.edu`);
  });

  it("gives the recipient the same in the other direction", async () => {
    const { caller } = meCallerFor(
      USER_B,
      accepted,
      RIDER_AND_DRIVER,
      {},
      BOTH_AT_HOME,
    );

    const result = await caller.user.requests.me();

    expect(result.received[0]!.fromUser!.startCoordLat).toBe(
      EXACT_HOME.coordLat,
    );
    expect(result.received[0]!.fromUser!.email).toBe(
      `${USER_A}@northeastern.edu`,
    );
  });
});

describe("user.requests.me - the status is read per request, not per response", () => {
  it("discloses the accepted counterpart and coarsens the pending one together", async () => {
    // The realistic shape: several outgoing requests, one of them accepted. A
    // fix applied to the response rather than to each row would either leak
    // every pending counterpart or blank out the accepted one.
    const { caller } = meCallerFor(
      USER_A,
      [
        requestRow("request-1", USER_A, USER_B, {
          status: RequestStatus.ACCEPTED,
        }),
        requestRow("request-2", USER_A, USER_C),
      ],
      { ...RIDER_AND_DRIVER, [USER_C]: Role.DRIVER },
      {},
      { ...BOTH_AT_HOME, [USER_C]: EXACT_HOME },
    );

    const result = await caller.user.requests.me();
    const byId = new Map(result.sent.map((req) => [req.id, req]));

    expect(byId.get("request-1")!.toUser!.startCoordLat).toBe(
      EXACT_HOME.coordLat,
    );
    expect(byId.get("request-1")!.toUser!.email).toBe(
      `${USER_B}@northeastern.edu`,
    );

    expect(byId.get("request-2")!.toUser!.startCoordLat).toBe(
      COARSE_HOME.coordLat,
    );
    expect(byId.get("request-2")!.toUser).not.toHaveProperty("email");
  });
});
