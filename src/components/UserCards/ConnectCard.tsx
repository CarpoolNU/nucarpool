import { toast } from "react-toastify/unstyled";
import {
  User,
  EnhancedPublicUser,
  PublicUser,
  ButtonInfo,
} from "../../utils/types";
import { UserCard } from "./UserCard";
import { useContext, useState } from "react";
import { createPortal } from "react-dom";
import ConnectModal from "./ConnectModal";
import { UserContext } from "../../utils/userContext";
import { Role } from "@prisma/client";
import { trackEvent } from "../../utils/mixpanel";
import useIsMobile from "../../utils/useIsMobile";
import { counterpartLabel } from "../Sidebar/viewerAccess";
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

  // This is a **discovery** card, so a VIEWER sees the other person's role in
  // place of their name — and the activation button's accessible
  // name has to respect that, or Viewer mode withholds the name on screen while
  // a screen reader reads it out.
  const label = counterpartLabel({
    viewerRole: user?.role ?? "",
    isCounterpart: false,
    preferredName: props.otherUser.preferredName,
    role: props.otherUser.role,
  });

  // Tapping the card expands it on mobile, and does nothing on desktop. That
  // used to be an `onClick` passed unconditionally with an `isMobile` check
  // inside it, which now matters: `UserCard` renders its stretched activation
  // button whenever `onClick` is present, so passing a no-op would put an empty
  // button across every desktop card and swallow clicks meant for the card's
  // own controls. Passing `undefined` renders no button at all.
  //
  // Restricting it also fixes a mobile bug: tapping the favourite star used to
  // bubble into this handler and expand the card.
  const activation =
    isMobile && props.handleMobileExpand
      ? {
          onClick: () => props.handleMobileExpand?.(props.otherUser.id),
          onClickLabel: `Show ${label}'s full details`,
        }
      : {};

  return (
    <>
      <UserCard
        otherUser={props.otherUser}
        rightButton={connectButtonInfo}
        onViewRouteClick={props.onViewRouteClick}
        {...activation}
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
