import {
  conversationsToDeleteWith,
  findOrCreateConversation,
  findOrphanConversationIds,
} from "./conversationLink";
import type { TransactionClient } from "./client";

/**
 * The shared request-to-conversation link repair.
 *
 * Two procedures need it and both got it wrong before sharing it:
 * `messages.sendMessage` discarded a first message on a request with no
 * conversation, and `requests.create`'s reopen branch did the same thing on
 * SCRUM-350. The repair is two statements in a fixed order against a link
 * stored in two places, so it is worth pinning on its own rather than only
 * through the routers.
 *
 * What matters here is the *key*. The lookup uses `Conversation.requestId`, the
 * `@unique` and authoritative side, not `Request.conversationId`. Those two can
 * disagree — nothing in the schema keeps them in agreement — and keying off the
 * request row would try to create a second conversation for a `requestId` that
 * already has one.
 */

const REQUEST_ID = "request-1";

/** Only the three delegate calls this helper issues. */
const buildTx = (existing: { id: string; requestId: string } | null) => {
  const conversationFindUnique = jest.fn(async ({ where }: any) =>
    existing && existing.requestId === where.requestId ? { ...existing } : null,
  );

  const conversationCreate = jest.fn(async ({ data }: any) => ({
    id: `conversation-${data.requestId}`,
    requestId: data.requestId,
  }));

  const requestUpdate = jest.fn(async ({ where, data }: any) => ({
    id: where.id,
    ...data,
  }));

  const tx = {
    conversation: {
      findUnique: conversationFindUnique,
      create: conversationCreate,
    },
    request: { update: requestUpdate },
  } as unknown as TransactionClient;

  return { tx, conversationFindUnique, conversationCreate, requestUpdate };
};

describe("findOrCreateConversation — a conversation already exists", () => {
  it("returns it without writing anything", async () => {
    const { tx, conversationCreate, requestUpdate } = buildTx({
      id: "conversation-existing",
      requestId: REQUEST_ID,
    });

    const conversation = await findOrCreateConversation(tx, REQUEST_ID);

    expect(conversation).toMatchObject({ id: "conversation-existing" });
    expect(conversationCreate).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("looks it up by requestId, not by the request row's own column", async () => {
    // The whole point of the key choice. A conversation whose request has a
    // null `conversationId` is still found, so the unique constraint on
    // `Conversation.requestId` cannot be violated by a redundant create.
    const { tx, conversationFindUnique } = buildTx({
      id: "conversation-orphan",
      requestId: REQUEST_ID,
    });

    await findOrCreateConversation(tx, REQUEST_ID);

    expect(conversationFindUnique).toHaveBeenCalledWith({
      where: { requestId: REQUEST_ID },
    });
  });
});

describe("findOrCreateConversation — no conversation yet", () => {
  it("creates one for the request", async () => {
    const { tx, conversationCreate } = buildTx(null);

    const conversation = await findOrCreateConversation(tx, REQUEST_ID);

    expect(conversationCreate).toHaveBeenCalledWith({
      data: { requestId: REQUEST_ID },
    });
    expect(conversation).toMatchObject({ requestId: REQUEST_ID });
  });

  it("links it back onto the request", async () => {
    // Without this half the conversation exists but the request does not point
    // at it, and `user.requests.me` reaches messages through the request — so
    // the thread would be invisible from the side the UI reads.
    const { tx, requestUpdate } = buildTx(null);

    await findOrCreateConversation(tx, REQUEST_ID);

    expect(requestUpdate).toHaveBeenCalledWith({
      where: { id: REQUEST_ID },
      data: { conversationId: `conversation-${REQUEST_ID}` },
    });
  });

  it("creates before linking, so the link never names a row that does not exist", async () => {
    const { tx, conversationCreate, requestUpdate } = buildTx(null);

    await findOrCreateConversation(tx, REQUEST_ID);

    expect(conversationCreate.mock.invocationCallOrder[0]).toBeLessThan(
      requestUpdate.mock.invocationCallOrder[0] as number,
    );
  });

  it("returns the conversation it created, so the caller need not re-read it", async () => {
    const { tx } = buildTx(null);

    await expect(findOrCreateConversation(tx, REQUEST_ID)).resolves.toEqual({
      id: `conversation-${REQUEST_ID}`,
      requestId: REQUEST_ID,
    });
  });
});

/**
 * The other half of the link problem: not a conversation missing
 * from a request, but a conversation nothing reaches.
 *
 * The predicate tests *both* links, because the relationship is stored twice
 * and either copy is enough to make a conversation readable. `requests.me` and
 * the unread count reach one through `Request.conversationId`, so a row whose
 * own `requestId` is dead can still be rendered. These cases pin that the
 * second link is honoured, which is what SCRUM-364 closed.
 */
describe("findOrphanConversationIds", () => {
  const conversation = (id: string, requestId: string) => ({ id, requestId });
  /** A live request row, optionally pointing back at a conversation. */
  const live = (id: string, conversationId: string | null = null) => ({
    id,
    conversationId,
  });

  it("selects exactly the conversations no live request reaches", () => {
    const conversations = [
      conversation("c-live", "r-live"),
      conversation("c-dead", "r-dead"),
      conversation("c-live-2", "r-live-2"),
    ];

    expect(
      findOrphanConversationIds(conversations, [
        live("r-live"),
        live("r-live-2"),
      ]),
    ).toEqual(["c-dead"]);
  });

  it("returns nothing when every conversation has its request", () => {
    expect(
      findOrphanConversationIds(
        [conversation("c", "r")],
        [live("r"), live("r-other")],
      ),
    ).toEqual([]);
  });

  /**
   * The cross-linked row: dead by `Conversation.requestId`, alive by
   * `Request.conversationId`. Nothing writes this state today, but the schema
   * permits it — the column is not unique and `Conversation.request` is a
   * `Request[]` — and calling it an orphan would plan the deletion of a thread
   * `requests.me` still renders. Worse, `Request.conversation` declares
   * `onDelete: Cascade`, so deleting it would take the live request too.
   */
  it("spares a conversation a live request still points at", () => {
    expect(
      findOrphanConversationIds(
        [conversation("c-crosslinked", "r-gone")],
        [live("r-other", "c-crosslinked")],
      ),
    ).toEqual([]);
  });

  it("still selects a row whose only referrer is itself gone", () => {
    // The same shape as above with the referring request removed, so the
    // previous case is passing for the cross-link and not by accident.
    expect(
      findOrphanConversationIds(
        [conversation("c-crosslinked", "r-gone")],
        [live("r-other", "c-something-else")],
      ),
    ).toEqual(["c-crosslinked"]);
  });

  it("ignores a null conversationId rather than matching on it", () => {
    // 462 of 477 requests on production-derived staging predate the
    // Conversation model and hold NULL here. Collecting those nulls into the
    // claimed set would make every conversation look reachable.
    expect(
      findOrphanConversationIds(
        [conversation("c-dead", "r-dead")],
        [live("r-live", null), live("r-live-2", null)],
      ),
    ).toEqual(["c-dead"]);
  });

  it("treats every conversation as an orphan when no requests remain", () => {
    // The shape a logic error would produce, which is what `--max` in the
    // script exists to stop from being acted on.
    expect(
      findOrphanConversationIds(
        [conversation("a", "r-a"), conversation("b", "r-b")],
        [],
      ),
    ).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty table", () => {
    expect(findOrphanConversationIds([], [live("r")])).toEqual([]);
  });

  it("is not confused by a request id that matches a conversation id", () => {
    // The two id spaces are separate cuids, but the set arithmetic must key
    // on `requestId` rather than on `id` for the right reason, not by luck.
    expect(
      findOrphanConversationIds([conversation("x", "y")], [live("x")]),
    ).toEqual(["x"]);
  });

  /**
   * The idempotency the cleanup depends on: feeding it the rows a previous run
   * would have left finds nothing to do.
   */
  it("finds nothing among the rows a previous run would have kept", () => {
    const conversations = [
      conversation("c-live", "r-live"),
      conversation("c-dead", "r-dead"),
    ];
    const requests = [live("r-live", "c-live")];

    const orphans = new Set(findOrphanConversationIds(conversations, requests));
    const survivors = conversations.filter((row) => !orphans.has(row.id));

    expect(findOrphanConversationIds(survivors, requests)).toEqual([]);
  });
});

describe("conversationsToDeleteWith", () => {
  it("covers both links when the request knows its conversation", () => {
    expect(
      conversationsToDeleteWith({ id: "r-1", conversationId: "c-1" }),
    ).toEqual([{ requestId: "r-1" }, { id: "c-1" }]);
  });

  it("omits the id filter when the request has no conversation", () => {
    // The important one. `{ id: undefined }` is read by `deleteMany` as "no
    // filter on id", so including it unconditionally would turn a delete of
    // one row into a delete of the whole table.
    const filters = conversationsToDeleteWith({
      id: "r-1",
      conversationId: null,
    });

    expect(filters).toEqual([{ requestId: "r-1" }]);
    for (const filter of filters) {
      expect(Object.values(filter)).not.toContain(undefined);
    }
  });

  it("is never empty, so `{ OR: [] }` cannot be built from it", () => {
    // Prisma treats an empty OR as matching nothing, which would silently
    // stop the cleanup rather than fail loudly — but a caller that spreads
    // this into a wider filter deserves the stronger guarantee.
    expect(
      conversationsToDeleteWith({ id: "r-1", conversationId: null }).length,
    ).toBeGreaterThan(0);
  });
});
