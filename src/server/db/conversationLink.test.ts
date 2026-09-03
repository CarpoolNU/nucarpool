import { findOrCreateConversation } from "./conversationLink";
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
