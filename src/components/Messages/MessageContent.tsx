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
import Pusher from "pusher-js";

interface MessageContentProps {
  selectedUser: EnhancedPublicUser;
}

import { isEqual } from "lodash";

const MessageContent = ({ selectedUser }: MessageContentProps) => {
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const utils = trpc.useContext();
  const user = useContext(UserContext);

  const request = useMemo(
    () => selectedUser.incomingRequest || selectedUser.outgoingRequest,
    [selectedUser.incomingRequest, selectedUser.outgoingRequest]
  );

  const [conversationMessages, setConversationMessages] = useState(
    request?.conversation?.messages || []
  );

  // Persist default date
  const defaultDateCreatedRef = useRef(new Date());

  const initialMessage = useMemo(() => {
    const dateCreated = request?.dateCreated || defaultDateCreatedRef.current;
    return {
      id: "initial",
      content: request?.message || "",
      conversationId: request?.conversation?.id || "initial",
      userId: request?.fromUserId || "",
      dateCreated,
      isRead: true,
    };
  }, [
    request?.message,
    request?.dateCreated,
    request?.fromUserId,
    request?.conversation?.id,
  ]);

  // Update messages from the request prop if it changes
  useEffect(() => {
    setConversationMessages(request?.conversation?.messages || []);
  }, [request?.conversation?.messages]);

  // New useEffect: When the component mounts or when the conversation changes,
  // fetch the latest conversation messages from the server in case new messages arrived.
  const { data: freshMessages } = trpc.user.messages.getMessages.useQuery(
    request?.conversation?.id ?? "",
    { enabled: !!request?.conversation?.id }
  );

  useEffect(() => {
    if (freshMessages) {
      setConversationMessages(freshMessages);
    }
  }, [freshMessages]);

  useEffect(() => {
    const pusher = new Pusher("988fdff5dc5909417348", {
      cluster: "us2",
    });

    const messageChannel = pusher.subscribe("conversation");

    messageChannel.bind(
      "sendMessage",
      (data: { requestId: string } & { newMessage: Message }) => {
        console.log("request ", request);
        console.log("data ", data);
        console.log("requestId ", data.requestId);
        console.log("message", data.newMessage);

        // Check if the new message belongs to the current conversation.
        // This now uses the conversation id if available, otherwise falls back to the request id.
        if (
          (request?.conversation?.id &&
            data.newMessage.conversationId === request.conversation.id) ||
          request?.id === data.requestId
        ) {
          setConversationMessages((prevMessages) => [
            ...prevMessages,
            data.newMessage,
          ]);
        }
      }
    );

    return () => {
      messageChannel.unbind("sendMessage");
      pusher.unsubscribe("conversation");
    };
  }, [request?.id, request?.conversation?.id]);

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
      [onSuccess, onError]
    )
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

  // Group messages by date
  const messagesByDate = [];
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

  useEffect(() => {
    scrollToBottom();
  }, [allMessages, scrollToBottom]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto overflow-x-hidden bg-white p-4">
      {messagesByDate.map(({ date, messages }, dateIndex) => (
        <div key={date}>
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
                  className={`max-w-[50%] rounded-lg px-4 py-2 text-base
                    sm:max-w-[50%] sm:text-sm
                    md:max-w-[50%] md:text-base
                    lg:max-w-[50%] lg:text-xl
                    ${
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
