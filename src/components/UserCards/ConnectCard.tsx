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
import { connectAction } from "./connectAction";
import { carpoolUnavailableExplanation } from "../../utils/roleCompatibility";
import { driverHasNoSeatsExplanation } from "../../utils/carpoolSeats";
import React from "react";

/**
 * Which surface this card is on, and therefore which controls it carries.
 *
 * **Why this exists rather than the selection id it replaces.** `ConnectCard`
 * used to infer "show the mobile action" from `mobileSelectedUser`, a prop
 * naming *which card the user expanded in the explore sheet*. One value was
 * answering two unrelated questions, and this type exists because the second
 * answer was wrong everywhere the first was not applicable: `MapConnectPortal`
 * has no selection to pass, so its card silently inherited list-card
 * behaviour and a map pin opened a sheet with nothing to press.
 *
 * Passing `mobileSelectedUser={user.id}` from the portal - the smaller
 * alternative - would have fixed the missing button and taken the card's
 * schedule, dates and seats rows down with it, because
 * `isMobileCondensedLayout` reads the same value. The portal wants the action
 * *and* the full detail, which is a third combination neither existing caller
 * expresses. Stating it is what stops the next surface inheriting the wrong
 * one by omission.
 *
 * - `list` - a discovery card in the explore list. Tapping the body expands it
 *   on mobile; the actions live in `UserCard`'s desktop-only row.
 * - `detail` - the one card in the mobile detail sheet. Condensed, because the
 *   sheet is short, and carrying its own full-width `Connect!`.
 * - `portal` - a card in the map-pin sheet. Full detail, and on mobile the
 *   same `Connect!`, because `UserCard`'s row is desktop-only.
 *
 * `View Route` is deliberately not offered on `portal`, matching the mobile
 * detail sheet rather than the desktop portal: the pin the user just tapped is
 * already on the map that route would draw on.
 */
export type ConnectCardVariant = "list" | "detail" | "portal";

interface ConnectCardProps {
  otherUser: EnhancedPublicUser;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  onClose?: (action: string) => void;
  onViewRequest: (userId: string) => void;
  /** Defaults to `list`, the only variant with more than one instance. */
  variant?: ConnectCardVariant;
  handleMobileExpand?: (userId?: string) => void;
}

export const ConnectCard = (props: ConnectCardProps): React.JSX.Element => {
  const user = useContext(UserContext);
  const [showModal, setShowModal] = useState(false);
  const isMobile = useIsMobile();
  const variant = props.variant ?? "list";

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
      otherSeatAvail: otherUser.seatAvail,
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
    // A sent request drops its recipient out of `recommendations.me` (the
    // router excludes anyone with an open request), so the mobile detail
    // sheet - scoped to that one card via `variant === "detail"` - would
    // otherwise be left pointed at a card no longer in the list: a blank
    // sheet with only the header's Back button able to leave it. Collapsing
    // back to the list here does what that Back button already does.
    if (isMobile && variant === "detail" && action === "closeAfterSend") {
      props.handleMobileExpand?.();
    }
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
  // ACTIVE people - so this is in practice the favourites tab. A later change stopped
  // `favorites.me` hiding a favourite whose role changed or whose search was
  // paused, because hiding them removed the only un-favourite star there is.
  // They are shown explained instead: the notice says why, and the Connect
  // affordance goes inert so the card does not read as if they were available.
  // `connectAction` refuses the same case, which is what actually prevents a
  // request that could be sent but never accepted.
  //
  // A driver who has filled up is the third reason, added later and
  // asked last because it is the most temporary of the three: a role change or
  // a paused search says the pair cannot carpool at all right now, while no
  // free seats says only *not yet*. Composed here rather than inside
  // `carpoolUnavailableExplanation` because seats are not role compatibility,
  // and because `connectAction` needs to ask the two questions at different
  // points in its order of precedence.
  const unavailable = user
    ? (carpoolUnavailableExplanation(user.role, {
        role: props.otherUser.role,
        status: props.otherUser.status,
        preferredName: props.otherUser.preferredName,
      }) ??
      driverHasNoSeatsExplanation({
        role: props.otherUser.role,
        seatAvail: props.otherUser.seatAvail,
        preferredName: props.otherUser.preferredName,
      }))
    : null;

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
          onClickLabel: `Show ${props.otherUser.preferredName}'s full details`,
        }
      : {};

  /**
   * The condensed layout belongs to the detail sheet alone.
   *
   * `UserCard` drops the schedule, dates and seats rows for it because that
   * sheet is deliberately short. A portal card is not short and keeps them.
   * `UserCard` already ands this with its own `isMobile`, so no viewport term
   * is needed here.
   */
  const isCondensedDetail = variant === "detail";

  /**
   * Whether this card carries its own full-width action.
   *
   * The `isMobile` term is load-bearing here in a way it was not for the
   * selection id this replaced. That value could only ever be non-null on a
   * phone - `index.tsx` derives it through `resolveMobileSelectedUser` - so
   * reading it alone was safe. `variant` carries no such guarantee:
   * `MapConnectPortal` sets `portal` on both platforms, and without this term
   * a desktop pin click would draw this button *underneath* the `View Route` +
   * `Connect` row `UserCard` already renders there, which is the one thing
   * this ticket must not change.
   */
  const showsOwnAction = isMobile && variant !== "list";

  return (
    <>
      <UserCard
        otherUser={props.otherUser}
        rightButton={connectButtonInfo}
        rightButtonDisabled={unavailable !== null}
        notice={unavailable ?? undefined}
        onViewRouteClick={props.onViewRouteClick}
        {...activation}
        isMobileCondensedLayout={isCondensedDetail}
      />
      {showsOwnAction && (
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
