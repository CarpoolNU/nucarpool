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
import { trackEvent } from "../../utils/mixpanel";
import useIsMobile from "../../utils/useIsMobile";
import { counterpartLabel } from "../Sidebar/viewerAccess";
import { connectAction } from "./connectAction";
import { carpoolUnavailableExplanation } from "../../utils/roleCompatibility";
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

  const handleConnect = (otherUser: EnhancedPublicUser) => {
    trackEvent("Connect Button Clicked", {
      userRole: user?.role,
      hasIncomingRequest: otherUser.incomingRequest,
      hasOutgoingRequest: otherUser.outgoingRequest,
    });

    // The three refusals and their wording live in `connectAction`, which tests
    // can reach. What used to be here tested a request's *presence*, so a
    // resolved one blocked Connect just as a pending one did — see that module
    // for why that made re-carpooling impossible.
    const decision = connectAction({
      incomingRequest: otherUser.incomingRequest,
      outgoingRequest: otherUser.outgoingRequest,
      viewerRole: user?.role,
      seatAvail: user?.seatAvail,
      preferredName: otherUser.preferredName,
      otherRole: otherUser.role,
      otherStatus: otherUser.status,
    });

    if (decision.kind === "blocked") {
      toast.info(decision.message);
      return;
    }

    setShowModal(true);
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

  // Why this pair cannot carpool right now, or `null`.
  //
  // Always `null` on a recommendation card - the scorer only offers compatible,
  // ACTIVE people - so this is in practice the favourites tab. SCRUM-351 stopped
  // `favorites.me` hiding a favourite whose role changed or whose search was
  // paused, because hiding them removed the only un-favourite star there is.
  // They are shown explained instead: the notice says why, and the Connect
  // affordance goes inert so the card does not read as if they were available.
  // `connectAction` refuses the same case, which is what actually prevents a
  // request that could be sent but never accepted.
  const unavailable = user
    ? carpoolUnavailableExplanation(user.role, {
        role: props.otherUser.role,
        status: props.otherUser.status,
        preferredName: props.otherUser.preferredName,
      })
    : null;

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
        rightButtonDisabled={unavailable !== null}
        notice={unavailable ?? undefined}
        onViewRouteClick={props.onViewRouteClick}
        {...activation}
        isMobileCondensedLayout={isMobile && props.mobileSelectedUser !== null}
      />
      {props.mobileSelectedUser !== null && isMobile && (
        <div className="mx-3.5 mt-2 mb-4">
          <button
            onClick={() => handleConnect(props.otherUser)}
            disabled={
              user?.role === "VIEWER" ||
              user?.status === "INACTIVE" ||
              unavailable !== null
            }
            className="bg-northeastern-red w-full rounded-md p-3 text-center font-semibold text-white hover:bg-red-700 disabled:bg-gray-300"
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
