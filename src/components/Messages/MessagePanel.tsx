import React, { useState, useContext, useEffect } from "react";
import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import MessageHeader from "./MessageHeader";
import MessageContent from "./MessageContent";
import SendBar from "./SendBar";
import { trpc } from "../../utils/trpc";
import { createRequestHandlers } from "../../utils/requestHandlers";
import { UserContext } from "../../utils/userContext";
import { toast } from "react-toastify";
import { trackRequestResponse } from "../../utils/mixpanel";

interface MessagePanelProps {
  selectedUser: EnhancedPublicUser;
  onMessageSent: (selectedUserId: string) => void;
  onCloseConversation: (userId: string) => void;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
}

const MessagePanel = ({
  selectedUser,
  onMessageSent,
  onCloseConversation,
  onViewRouteClick,
}: MessagePanelProps) => {
  const [activeTab, setActiveTab] = useState<"message" | "map">("message");
  const utils = trpc.useContext();
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
    setActiveTab("map");
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
        <div className="flex border-b border-gray-200 bg-white">
          <button
            className={`flex-1 py-3 text-center text-lg font-medium ${
              activeTab === "message"
                ? "border-b-2 border-northeastern-red text-northeastern-red"
                : ""
            }`}
            onClick={() => setActiveTab("message")}
          >
            Message
          </button>
          <button
            className={`flex-1 py-3 text-center text-lg font-medium ${
              activeTab === "map"
                ? "border-b-2 border-northeastern-red text-northeastern-red"
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
