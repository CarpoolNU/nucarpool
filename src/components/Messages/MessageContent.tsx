import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EnhancedPublicUser, Message } from "../../utils/types";
import { format, isSameDay } from "date-fns";
import { trpc } from "../../utils/trpc";
import { UserContext } from "../../utils/userContext";
import { conversationChannel } from "../../utils/pusherChannels";
import {
  acquirePusherClient,
  releasePusherClient,
} from "../../utils/pusherClient";

interface MessageContentProps {
  selectedUser: EnhancedPublicUser;
}

import { isEqual } from "lodash";

const MessageContent = ({ selectedUser }: MessageContentProps) => {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const utils = trpc.useUtils();
  const user = useContext(UserContext);

  const request = useMemo(
    () => selectedUser.incomingRequest || selectedUser.outgoingRequest,
    [selectedUser.incomingRequest, selectedUser.outgoingRequest],
  );

  /**
   * The thread's own paginated source.
   *
   * This used to read `request.conversation.messages`, which arrived inside
   * `user.requests.me` and carried the complete history of *every* conversation
   * on every mount. That payload is now bounded to one message per card, so the
   * thread has to fetch its own — which also means it is no longer refetched
   * wholesale every time the user navigates back to `/`.
   *
   * "Next page" is *older*, because the procedure returns newest-first. Pages
   * are concatenated newest-page-first, so flattening walks backwards through
   * history and has to be reversed per page to end up in render order.
   */
  const threadQuery = trpc.user.messages.conversation.useInfiniteQuery(
    { requestId: request?.id ?? "" },
    {
      enabled: !!request?.id,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      refetchOnMount: "always",
    },
  );

  const fetchedMessages = useMemo(
    () =>
      (threadQuery.data?.pages ?? [])
        .slice()
        .reverse()
        .flatMap((page) => page.messages),
    [threadQuery.data?.pages],
  );

  const [conversationMessages, setConversationMessages] = useState<Message[]>(
    [],
  );

  // Persist default date r
  const defaultDateCreatedRef = useRef(new Date());

  const initialMessage = useMemo(() => {
    const dateCreated = request?.dateCreated || defaultDateCreatedRef.current;
    return {
      id: "initial",
      content: request?.message || "",
      conversationId: "initial",
      userId: request?.fromUserId || "",
      dateCreated,
      isRead: true,
    };
  }, [request?.message, request?.dateCreated, request?.fromUserId]);

  /**
   * Fetched pages are the source of truth; Pusher only ever appends to the tail.
   * Merging by id rather than replacing, so a message that arrived in real time
   * is not dropped when an older page lands and the pages array changes.
   */
  useEffect(() => {
    setConversationMessages((live) => {
      const seen = new Set(fetchedMessages.map((message) => message.id));
      const liveOnly = live.filter((message) => !seen.has(message.id));
      return [...fetchedMessages, ...liveOnly];
    });
  }, [fetchedMessages]);

  useEffect(() => {
    const requestId = request?.id;
    if (!requestId) return;

    // Shared client, created on first acquire and disconnected when the last
    // holder releases it. Private channel: Pusher will not join it
    // until /api/pusher/auth signs the subscription for this session
    const pusher = acquirePusherClient();

    const channelName = conversationChannel(requestId);
    const messageChannel = pusher.subscribe(channelName);

    // Authorization is a new failure mode; without this it would fail silently
    // and look like messaging had simply stopped updating.
    messageChannel.bind("pusher:subscription_error", (status: unknown) => {
      console.error(`Could not subscribe to ${channelName}`, status);
    });

    messageChannel.bind("sendMessage", (data: { newMessage: Message }) => {
      setConversationMessages((prevMessages) => {
        if (prevMessages.some((m) => m.id === data.newMessage.id)) {
          return prevMessages;
        }
        return [...prevMessages, data.newMessage];
      });
    });

    return () => {
      messageChannel.unbind("sendMessage");
      messageChannel.unbind("pusher:subscription_error");
      pusher.unsubscribe(channelName);
      releasePusherClient();
    };
  }, [request?.id]);

  const allMessages = useMemo(() => {
    if (request?.message) {
      return [initialMessage, ...conversationMessages];
    }
    return [...conversationMessages];
  }, [initialMessage, conversationMessages, request?.message]);

  const onSuccess = useCallback(() => {
    utils.user.messages.getUnreadMessageCount.invalidate();
    utils.user.requests.me.invalidate();
  }, [utils.user.messages.getUnreadMessageCount, utils.user.requests.me]);

  const onError = useCallback((error: any) => {
    console.error("Failed to mark messages as read:", error);
  }, []);

  const markMessagesAsRead = trpc.user.messages.markMessagesAsRead.useMutation(
    useMemo(
      () => ({
        onSuccess,
        onError,
      }),
      [onSuccess, onError],
    ),
  );

  // useref to store previous unread messages
  const prevUnreadMessageIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (user) {
      const unreadMessageIds = allMessages
        .filter((message) => !message.isRead && message.userId !== user.id)
        .map((message) => message.id);

      if (!isEqual(unreadMessageIds, prevUnreadMessageIdsRef.current)) {
        if (unreadMessageIds.length > 0) {
          markMessagesAsRead.mutate({ messageIds: unreadMessageIds });
        }
        prevUnreadMessageIdsRef.current = unreadMessageIds;
      }
    }
  }, [user, allMessages, markMessagesAsRead]);

  // Group messages by date.
  // Annotated rather than inferred: `currentDate` is only ever assigned inside
  // the forEach callback below, and TypeScript's control-flow analysis does not
  // track that, so the evolving-array type came out as `{ date: null }` and
  // every use of `date` was silently typed `never`.
  const messagesByDate: {
    date: Date | null;
    messages: typeof allMessages;
  }[] = [];
  let currentDate: Date | null = null;
  let currentMessages: typeof allMessages = [];

  allMessages.forEach((message) => {
    const messageDate = message.dateCreated
      ? new Date(message.dateCreated)
      : new Date();

    if (!currentDate || !isSameDay(currentDate, messageDate)) {
      if (currentMessages.length > 0) {
        messagesByDate.push({ date: currentDate, messages: currentMessages });
      }
      currentDate = messageDate;
      currentMessages = [message];
    } else {
      currentMessages.push(message);
    }
  });

  if (currentMessages.length > 0) {
    messagesByDate.push({ date: currentDate, messages: currentMessages });
  }

  const currentUserId = user?.id;

  const scrollToBottom = useCallback(() => {
    if (messagesEndRef.current) {
      const container = messagesEndRef.current.closest(".overflow-y-auto");
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
  }, []);

  /**
   * Only follow the tail, never a prepend.
   *
   * This used to fire on any change to `allMessages`, which was fine while the
   * whole history arrived at once. With "load older" it would yank the reader
   * from the message they had scrolled back to down to the newest one — the
   * opposite of what they asked for. Keyed on the id of the *last* message, so
   * appends scroll and prepends do not.
   */
  const lastMessageId = allMessages[allMessages.length - 1]?.id;

  useEffect(() => {
    scrollToBottom();
  }, [lastMessageId, scrollToBottom]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto overflow-x-hidden bg-white p-4">
      {/* Older history is fetched on request rather than shipped with every
          Requests-tab load. Rendered only when the server said
          another page exists, so a short thread shows nothing at all. */}
      {threadQuery.hasNextPage && (
        <div className="mb-2 flex justify-center">
          <button
            type="button"
            onClick={() => void threadQuery.fetchNextPage()}
            disabled={threadQuery.isFetchingNextPage}
            className="rounded-full px-4 py-1 text-sm text-gray-600 underline hover:text-northeastern-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-northeastern-red disabled:cursor-not-allowed disabled:no-underline disabled:opacity-60"
          >
            {threadQuery.isFetchingNextPage
              ? "Loading older messages…"
              : "Load older messages"}
          </button>
        </div>
      )}
      {messagesByDate.map(({ date, messages }, dateIndex) => (
        // React keys must be strings or numbers; `date` is a Date (and typed
        // nullable), so it was being coerced on every render.
        <div key={date ? date.toISOString() : `group-${dateIndex}`}>
          <div className="text-md my-2 text-center text-gray-500">
            {date ? format(date, "EEEE, MMMM d, yyyy") : ""}
          </div>
          {messages.map((message, messageIndex) => {
            const isFromCurrentUser = message.userId === currentUserId;
            const messageTime = message.dateCreated
              ? format(new Date(message.dateCreated), "h:mm aa")
              : "";

            // Add ref to the last message of the last date group
            const isLastMessage =
              dateIndex === messagesByDate.length - 1 &&
              messageIndex === messages.length - 1;

            return (
              <div
                key={message.id}
                ref={isLastMessage ? messagesEndRef : null}
                className={`mb-4 flex flex-col ${
                  isFromCurrentUser ? "items-end pr-10" : "items-start pl-10"
                }`}
              >
                <span className="mb-1 text-xs text-gray-500">
                  {messageTime}
                </span>
                <div
                  className={`max-w-[50%] rounded-lg px-4 py-2 text-base sm:max-w-[50%] sm:text-sm md:max-w-[50%] md:text-base lg:max-w-[50%] lg:text-xl ${
                    isFromCurrentUser
                      ? "bg-northeastern-red text-white"
                      : "bg-gray-200 text-black"
                  }`}
                >
                  {message.content}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default MessageContent;
