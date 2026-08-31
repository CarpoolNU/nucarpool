import { Message, Request } from "./types";

/**
 * `request.message` is a dead column, and this synthetic message is **not**
 * dead code (SCRUM-250).
 *
 * `requests.create` hardcodes `Request.message` to `""` and puts the student's
 * actual text in the conversation's first `Message` instead, so `content` below
 * is empty for every row created since. SCRUM-250 listed this as a dead
 * rendering path; it is not. The synthetic message is load-bearing for its
 * *other* fields: `dateCreated` and `isRead` are what give a request with no
 * conversation messages an unread state and a sort position, via
 * `getCardSortingData`.
 *
 * So the column is what should go, not this. Dropping it is a schema change
 * plus a PlanetScale deploy request, which is why it was left out of the
 * dead-code sweep. Until then the empty `content` is harmless — a real message
 * always sorts newer.
 */
export const getLatestMessageForRequest = (
  request: Request,
  currentUserId: string,
): Message | null => {
  if (!request) return null;

  const initialMessage: Message = {
    conversationId: "",
    id: `request-${request.id}`,
    content: request.message,
    userId: request.fromUserId,
    dateCreated: request.dateCreated || new Date(),
    isRead: request.fromUserId === currentUserId,
  };

  const conversationMessages: Message[] = request.conversation?.messages || [];

  const allMessages = [initialMessage, ...conversationMessages];

  allMessages.sort(
    (a, b) =>
      new Date(b.dateCreated).getTime() - new Date(a.dateCreated).getTime(),
  );

  return allMessages[0];
};
export const getCardSortingData = (
  userId: string,
  request: Request,
  latestMessage: Message | null,
) => {
  const isUnread = latestMessage
    ? !latestMessage.isRead && userId !== latestMessage.userId
    : false;
  const latestActivityDate = latestMessage
    ? latestMessage.dateCreated
    : request.dateCreated;

  return { isUnread, latestActivityDate };
};
