import React, { useState, useContext, useEffect } from "react";
import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import MessageHeader from "./MessageHeader";
import MessageContent from "./MessageContent";
import SendBar from "./SendBar";
import { trpc } from "../../utils/trpc";
import { createRequestHandlers } from "../../utils/requestHandlers";
import { UserContext } from "../../utils/userContext";
import { toast } from "react-toastify/unstyled";
import { trackRequestResponse } from "../../utils/mixpanel";

interface MessagePanelProps {
  selectedUser: EnhancedPublicUser;
  onMessageSent: (selectedUserId: string) => void;
  onCloseConversation: (userId: string) => void;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
}

type MessagePanelTab = "message" | "map";

interface ConversationPanelProps extends MessagePanelProps {
  activeTab: MessagePanelTab;
  onTabChange: (tab: MessagePanelTab) => void;
}

/**
 * One conversation's state lives and dies with that conversation (SCRUM-558).
 *
 * On desktop the Requests sidebar stays beside the open panel, so clicking a
 * second card swaps `selectedUser` under a panel that stays mounted. Nothing
 * keyed it, so everything below survived the switch: `MessageContent`'s
 * merge-by-id kept the first thread's messages - they are not in the second
 * thread's fetch, which is exactly what the merge preserves - and drew them as
 * the new person's; `SendBar` kept the half-typed draft in its state and its
 * contentEditable, and `handleSendMessage` reads the *current* `selectedUser`,
 * so the next Enter sent A's draft to B; and `hasCalculatedRoute` stayed true,
 * so on the Map tab B's route was never drawn.
 *
 * Keyed here rather than at the call site so that no caller can forget it, and
 * so that `MessagePanel.conversationSwitch.test.tsx` can exercise the real key
 * rather than one of its own. **The key is the request, not the object**: a
 * send refetches `user.requests.me`, which rebuilds `selectedUser` for the
 * same conversation, and remounting on that would throw away the thread's
 * Pusher-only messages and the next draft.
 *
 * The tab is the one piece of state held outside the key, deliberately. It is
 * the user's choice of view, not the conversation's, and keeping it is what
 * makes a switch on the Map tab draw the new route instead of dropping back to
 * the thread; the remount resets `hasCalculatedRoute`, so the route effect
 * below runs for the new person.
 */
const MessagePanel = (props: MessagePanelProps) => {
  const [activeTab, setActiveTab] = useState<MessagePanelTab>("message");
  const request =
    props.selectedUser.incomingRequest || props.selectedUser.outgoingRequest;

  return (
    <ConversationPanel
      key={request?.id ?? props.selectedUser.id}
      {...props}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
};

const ConversationPanel = ({
  selectedUser,
  onMessageSent,
  onCloseConversation,
  onViewRouteClick,
  activeTab,
  onTabChange,
}: ConversationPanelProps) => {
  const utils = trpc.useUtils();
  const user = useContext(UserContext);
  const [hasCalculatedRoute, setHasCalculatedRoute] = useState(false);

  // Create request handlers
  const { handleAcceptRequest, handleRejectRequest, isMutating } =
    createRequestHandlers(utils);

  const sendMessage = trpc.user.messages.sendMessage.useMutation({
    // Without this a failed send was completely invisible: the
    // composed text disappeared from the box and nothing was ever delivered.
    onError: (error: any) => {
      toast.error(`Your message could not be sent: ${error.message}`);
    },
    onSuccess: () => {
      // The thread's own source, and the reason this line exists: the only
      // other way the sender's message reached the open conversation was the
      // Pusher echo, and the server treats that delivery as best-effort -
      // `message.ts` catches a trigger failure, logs that the row was saved,
      // and returns success. So a Pusher outage or a refused private-channel
      // subscription produced a send that cleared the box, raised no toast,
      // updated the sidebar card's preview (that is `onMessageSent` below) and
      // left the conversation the user was looking at unchanged. Nothing came
      // along to correct it either: the global policy sets `refetchOnMount`
      // and `refetchOnWindowFocus` to false, and the thread's own
      // `refetchOnMount: "always"` only helps once it is closed and reopened.
      //
      // The echo stays as the path for the *recipient*, who has no mutation to
      // hang an invalidation off. `MessageContent` merges by id, so the two
      // arriving for the same message is not a duplicate.
      utils.user.messages.conversation.invalidate();
      onMessageSent(selectedUser.id);
    },
  });

  const { mutate: sendMessageNotification } =
    trpc.user.emails.sendMessageNotification.useMutation({
      onError: (error: any) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      onSuccess() {
        console.log("Message notification email sent successfully");
      },
    });

  const handleSendMessage = async (content: string) => {
    const request =
      selectedUser.incomingRequest || selectedUser.outgoingRequest;
    const requestId = request?.id;
    if (!requestId) {
      // Used to be a bare `return`, which let `SendBar` clear the box for a
      // message that was never sent anywhere.
      toast.error("This conversation is no longer available.");
      throw new Error("No request for the selected conversation");
    }

    // This is the **newest message only**, not the thread:
    // `user.requests.me` is bounded to one message per conversation, and the
    // full history lives behind `user.messages.conversation`, which this
    // component does not query.
    //
    // The heuristic survives that, because of what it is for: "do not email
    // them if they have just messaged me". If the newest message is theirs, the
    // check below still sees it and suppresses the email exactly as before. If
    // the newest message is mine, then they have not just messaged me — I am
    // the one talking — and emailing is the right call anyway.
    //
    // The residual case is a burst: they message, I reply, I send again 20
    // seconds later. The newest message is mine, so this asks for a
    // notification. Harmless, and deliberately not worth another query: as the
    // comment below says, the server applies its own cooldown and is
    // authoritative. The cost of being wrong here is one pointless call, never
    // a duplicate email.
    const converstationMessages = request.conversation?.messages;

    // If the last message from the recipient is less than 5 mins old, don't send email notification
    let notifyByEmail = true;
    if (converstationMessages && converstationMessages.length > 0) {
      const recipientMessages = converstationMessages.filter(
        (msg) => msg.userId === selectedUser.id,
      );
      const lastMessageFromRecipient =
        recipientMessages[recipientMessages.length - 1];
      if (lastMessageFromRecipient) {
        const lastMsgTime = new Date(
          lastMessageFromRecipient.dateCreated,
        ).getTime();
        const minsDiff = (Date.now() - lastMsgTime) / (1000 * 60);
        if (minsDiff < 5) {
          notifyByEmail = false;
        }
      }
    }

    // The notification body is read from the stored message, so it
    // has to be sent once the write has landed rather than alongside it. The
    // server applies its own cooldown; this check only avoids a pointless call.
    // `mutateAsync` rather than `mutate` so `SendBar` finds out whether the
    // write landed and can leave the text in the box if it did not.
    // The rejection is caught there; the toast still comes from
    // `onError` above.
    await sendMessage.mutateAsync({ requestId, content });

    if (notifyByEmail) {
      sendMessageNotification({ requestId });
    }
  };

  const { mutate: sendAcceptanceNotification } =
    trpc.user.emails.sendAcceptanceNotification.useMutation({
      onError: (error: any) => {
        toast.error(`Failed to send acceptance notification: ${error.message}`);
      },
      onSuccess() {
        console.log("Acceptance notification email sent successfully");
      },
    });

  const handleAccept = async () => {
    if (!user || !selectedUser) return;

    const request = selectedUser.incomingRequest;
    if (!request) return;

    trackRequestResponse("accept", user.role);

    const accepted = await handleAcceptRequest(user, selectedUser, request);

    // Both of these used to run whatever happened, so a refused accept still
    // emailed the other person to say they had been accepted and still closed
    // the conversation. That matters most on a double-click: the second call is
    // now a clean rejection server-side, but the notification
    // endpoint is deliberately not rate limited, so without this the duplicate
    // email would be sent anyway.
    if (!accepted) {
      return;
    }

    // Both parties and the template are resolved server-side from the request.
    sendAcceptanceNotification({ requestId: request.id });

    onCloseConversation(""); // Close the conversation after accepting
  };

  const handleReject = async () => {
    if (!user || !selectedUser) return;

    const request =
      selectedUser.incomingRequest || selectedUser.outgoingRequest;
    if (!request) return;

    trackRequestResponse("decline", user.role);

    await handleRejectRequest(user, selectedUser, request);
  };
  const handleMapSwitch = () => {
    onTabChange("map");
    setHasCalculatedRoute(false);
  };
  useEffect(() => {
    if (activeTab === "map" && user && selectedUser && !hasCalculatedRoute) {
      try {
        onViewRouteClick(user, selectedUser);
        setHasCalculatedRoute(true);
      } catch (error) {
        console.error("Error calculating route:", error);
        // do not set hasCalculatedRoute to true so we can retry
      }
    }
  }, [activeTab, user, selectedUser, onViewRouteClick, hasCalculatedRoute]);

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header and Tabs */}
      <div className="pointer-events-auto">
        <MessageHeader
          selectedUser={selectedUser}
          onAccept={handleAccept}
          onReject={handleReject}
          onClose={onCloseConversation}
          groupId={user!.carpoolId}
          isMutating={isMutating}
        />

        {/* Tab Strip */}
        <div role="tablist" className="flex border-b border-gray-200 bg-white">
          <button
            role="tab"
            aria-selected={activeTab === "message"}
            className={`flex-1 py-3 text-center text-lg font-medium ${
              activeTab === "message"
                ? "border-northeastern-red text-northeastern-red border-b-2"
                : ""
            }`}
            onClick={() => onTabChange("message")}
          >
            Message
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "map"}
            className={`flex-1 py-3 text-center text-lg font-medium ${
              activeTab === "map"
                ? "border-northeastern-red text-northeastern-red border-b-2"
                : ""
            }`}
            onClick={() => handleMapSwitch()}
          >
            Map
          </button>
        </div>
      </div>

      {/* Content Area */}
      {activeTab === "message" && (
        <div className="pointer-events-auto flex h-0 flex-1 flex-col bg-white">
          <MessageContent selectedUser={selectedUser} />
          <SendBar onSendMessage={handleSendMessage} />
        </div>
      )}
    </div>
  );
};

export default MessagePanel;
