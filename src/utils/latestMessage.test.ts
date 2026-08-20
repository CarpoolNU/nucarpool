import {
  getCardSortingData,
  getLatestMessageForRequest,
} from "./latestMessage";
import type { Message, Request } from "./types";

/**
 * These two drive the request card's unread dot and its position in the list, so
 * the behaviour that matters is which message is treated as "latest" and when a
 * card counts as unread.
 */

const SENDER = "user-sender";
const RECEIVER = "user-receiver";

const message = (overrides: Partial<Message> = {}): Message => ({
  id: "msg-1",
  conversationId: "conversation-1",
  content: "See you at 8:45",
  isRead: false,
  userId: SENDER,
  dateCreated: new Date(2024, 0, 2),
  ...overrides,
});

const request = (overrides: Partial<Request> = {}): Request => ({
  id: "request-1",
  message: "Would you like to carpool?",
  fromUserId: SENDER,
  toUserId: RECEIVER,
  fromUser: null,
  toUser: null,
  conversationId: "conversation-1",
  conversation: { id: "conversation-1", requestId: "request-1", messages: [] },
  dateCreated: new Date(2024, 0, 1),
  ...overrides,
});

describe("getLatestMessageForRequest", () => {
  it("synthesises a message from the request itself when the conversation is empty", () => {
    const result = getLatestMessageForRequest(request(), RECEIVER);

    expect(result).toMatchObject({
      id: "request-request-1",
      content: "Would you like to carpool?",
      userId: SENDER,
      dateCreated: new Date(2024, 0, 1),
    });
  });

  it("handles a request with no conversation relation loaded", () => {
    const result = getLatestMessageForRequest(
      request({ conversation: null }),
      RECEIVER,
    );

    expect(result?.content).toBe("Would you like to carpool?");
  });

  it("returns the newest conversation message when one is newer than the request", () => {
    const result = getLatestMessageForRequest(
      request({
        conversation: {
          id: "conversation-1",
          requestId: "request-1",
          messages: [
            message({ id: "msg-1", dateCreated: new Date(2024, 0, 2) }),
            message({
              id: "msg-2",
              content: "Actually 9:00",
              dateCreated: new Date(2024, 0, 4),
            }),
            message({ id: "msg-3", dateCreated: new Date(2024, 0, 3) }),
          ],
        },
      }),
      RECEIVER,
    );

    expect(result?.id).toBe("msg-2");
    expect(result?.content).toBe("Actually 9:00");
  });

  it("keeps the request itself as latest when every reply predates it", () => {
    const result = getLatestMessageForRequest(
      request({
        dateCreated: new Date(2024, 0, 10),
        conversation: {
          id: "conversation-1",
          requestId: "request-1",
          messages: [message({ dateCreated: new Date(2024, 0, 2) })],
        },
      }),
      RECEIVER,
    );

    expect(result?.id).toBe("request-request-1");
  });

  it("marks the synthesised request message read for its own author", () => {
    expect(getLatestMessageForRequest(request(), SENDER)?.isRead).toBe(true);
    expect(getLatestMessageForRequest(request(), RECEIVER)?.isRead).toBe(false);
  });

  it("returns null when there is no request", () => {
    expect(
      getLatestMessageForRequest(undefined as unknown as Request, RECEIVER),
    ).toBeNull();
  });
});

describe("getCardSortingData", () => {
  it("marks a card unread when the newest message is from the other user and unread", () => {
    const latest = message({ userId: SENDER, isRead: false });

    expect(getCardSortingData(RECEIVER, request(), latest).isUnread).toBe(true);
  });

  it("does not mark a card unread for the author of the newest message", () => {
    const latest = message({ userId: SENDER, isRead: false });

    expect(getCardSortingData(SENDER, request(), latest).isUnread).toBe(false);
  });

  it("does not mark a card unread once the message has been read", () => {
    const latest = message({ userId: SENDER, isRead: true });

    expect(getCardSortingData(RECEIVER, request(), latest).isUnread).toBe(
      false,
    );
  });

  it("treats a card with no messages as read", () => {
    expect(getCardSortingData(RECEIVER, request(), null).isUnread).toBe(false);
  });

  it("sorts on the newest message's date when there is one", () => {
    const latest = message({ dateCreated: new Date(2024, 0, 9) });

    expect(
      getCardSortingData(RECEIVER, request(), latest).latestActivityDate,
    ).toEqual(new Date(2024, 0, 9));
  });

  it("falls back to the request's own date when there is no message", () => {
    expect(
      getCardSortingData(RECEIVER, request(), null).latestActivityDate,
    ).toEqual(new Date(2024, 0, 1));
  });
});
