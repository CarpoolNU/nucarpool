import { toast } from "react-toastify";
import {
  User,
  EnhancedPublicUser,
  PublicUser,
  ButtonInfo,
} from "../../utils/types";
import { UserCard } from "./UserCard";
import { useContext, useState } from "react";
import { createPortal } from "react-dom";
import ConnectModal from "../Modals/ConnectModal";
import { UserContext } from "../../utils/userContext";
import { Role } from "@prisma/client";
import { trackEvent } from "../../utils/mixpanel";
import useIsMobile from "../../utils/useIsMobile";
import React from "react";

interface ConnectCardProps {
  otherUser: EnhancedPublicUser;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  onClose?: (action: string) => void;
  onViewRequest: (userId: string) => void;
  mobileSelectedUser?: string | null;
  handleMobileExpand?: (userId?: string) => void;
}

export const ConnectCard = (props: ConnectCardProps): React.JSX.Element => {
  const user = useContext(UserContext);
  const [showModal, setShowModal] = useState(false);
  const isMobile = useIsMobile();

  const handleExistingReceivedRequest = () => {
    toast.info(
      "You already have an incoming carpool request from " +
        props.otherUser.preferredName +
        ". Navigate to the received requests tab to connect with them!",
    );
  };

  const handleExistingSentRequest = () => {
    toast.info(
      "You already have an outgoing carpool request to " +
        props.otherUser.preferredName +
        ". Please wait for them to respond to your request!",
    );
  };

  const handleNoSeatAvailability = () => {
    toast.info(
      "You do not have any seats available in your car to connect with " +
        props.otherUser.preferredName +
        ".",
    );
  };

  const handleConnect = (otherUser: EnhancedPublicUser) => {
    trackEvent("Connect Button Clicked", {
      userRole: user?.role,
      hasIncomingRequest: otherUser.incomingRequest,
      hasOutgoingRequest: otherUser.outgoingRequest,
    });

    if (otherUser.incomingRequest) {
      handleExistingReceivedRequest();
    } else if (otherUser.outgoingRequest) {
      handleExistingSentRequest();
    } else if (user?.role === Role.DRIVER && user.seatAvail === 0) {
      handleNoSeatAvailability();
    } else {
      setShowModal(true);
    }
  };

  const onClose = (action: string) => {
    props.onClose?.(action);
    setShowModal(false);
  };

  const connectButtonInfo: ButtonInfo = {
    text: "Connect",
    onPress: () => handleConnect(props.otherUser),
    color: "bg-northeastern-red",
  };
  return (
    <>
      <UserCard
        otherUser={props.otherUser}
        rightButton={connectButtonInfo}
        onViewRouteClick={props.onViewRouteClick}
        onClick={() => {
          if (isMobile) {
            props.handleMobileExpand?.(props.otherUser.id);
          }
        }}
        isMobileCondensedLayout={isMobile && props.mobileSelectedUser !== null}
      />
      {props.mobileSelectedUser !== null && isMobile && (
        <div className="mx-3.5 mb-4 mt-2">
          <button
            onClick={() => handleConnect(props.otherUser)}
            disabled={user?.role === "VIEWER" || user?.status === "INACTIVE"}
            className="w-full rounded-md bg-northeastern-red p-3 text-center font-semibold text-white hover:bg-red-700 disabled:bg-gray-300"
          >
            Connect!
          </button>
        </div>
      )}
      {showModal &&
        user &&
        createPortal(
          <ConnectModal
            user={user}
            otherUser={props.otherUser}
            onViewRequest={props.onViewRequest}
            onClose={onClose}
          />,
          document.body,
        )}
    </>
  );
};
