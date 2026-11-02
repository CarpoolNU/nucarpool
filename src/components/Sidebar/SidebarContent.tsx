import React, { useContext } from "react";
import {
  EnhancedPublicUser,
  Message,
  PublicUser,
  User,
} from "../../utils/types";
import Spinner from "../Spinner";
import { ConnectCard, ConnectCardVariant } from "../UserCards/ConnectCard";
import { ReceivedCard } from "../UserCards/ReceivedCard";
import { SentCard } from "../UserCards/SentCard";
import {
  getCardSortingData,
  getLatestMessageForRequest,
} from "../../utils/latestMessage";
import { UserContext } from "../../utils/userContext";
import { QueryState } from "../../utils/queryState";
import { QueryError } from "../QueryError";
import { viewerModeHidesCards } from "./viewerAccess";
import { RiderDemandNotice } from "../RiderDemandNotice";

interface SidebarContentProps {
  subType: string;
  userCardList: EnhancedPublicUser[];
  /**
   * Whether the list behind this tab loaded. Without it an empty
   * `userCardList` meant three different things - loading, failed, and genuinely
   * empty - and all three rendered the same "no results" copy.
   */
  loadState: QueryState;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  disabled: boolean;
  onCardClick: (userId: string) => void;
  selectedUser: EnhancedPublicUser | null;
  onViewRequest: (userId: string) => void;
  mobileSelectedUser?: string | null;
  handleMobileExpand?: (userId?: string) => void;
  /** Forwarded to the recommendations/favorites `ConnectCard`'s `onClose`, so a caller can react to the connect flow closing (e.g. resetting the active tab after a send). */
  onConnectClose?: (action: string) => void;
  /**
   * How many riders this user could carry if they drove, floored by the
   * server, or `null` when they are to be told nothing.
   *
   * Rendered under the recommendations empty state and under the Viewer-mode
   * copy — the two places a reader has just been told the product found them
   * nobody, which is the moment the platform has their attention and
   * currently spends it on a dead end. Never under favorites or requests:
   * those lists being empty says nothing about driver supply.
   */
  riderDemandCount?: number | null;
}

const emptyMessages = {
  recommendations: `We're unable to find any recommendations for you right now.
  We recommend reviewing your profile to make sure all information you've entered is accurate!`,
  disabledRec:
    "You are currently in Viewer mode, to get recommendations select Driver or Rider in profile.",
  /**
   * A VIEWER with no requests at all. The non-Viewer copy below points at the
   * recommendations sidebar, which is the one place Viewer mode genuinely does
   * block, so it would be misdirection here.
   */
  viewerNoRequests: `You have no incoming or outgoing requests.
  Viewer mode does not show recommendations, so switch to Rider or Driver in your profile to find people to carpool with.`,
  favorites: `You have no users currently favorited.
  Click the star icon on the upper-right side of a user's card to add them to your favorites!`,
  sent: "You have no current outgoing requests. Send requests to other users through the recommendations sidebar!",
  received: "You have no current incoming requests. Hold tight!",
  all: "You have no incoming or outgoing requests. Send a request or hold tight!",
};

/** Completes "We could not load ..." in the error state. */
const errorSubject = (card: string): string => {
  switch (card) {
    case "recommendations":
      return "your recommendations";
    case "favorites":
      return "your favorites";
    case "sent":
      return "your sent requests";
    case "received":
      return "your received requests";
    case "all":
      return "your requests";
    default:
      return "this list";
  }
};

const emptyMessage = (card: string, disabled: boolean): string => {
  switch (card) {
    case "recommendations":
      return disabled
        ? emptyMessages.disabledRec
        : emptyMessages.recommendations;
    case "favorites":
      return emptyMessages.favorites;
    case "sent":
      return disabled ? emptyMessages.viewerNoRequests : emptyMessages.sent;
    case "received":
      return disabled ? emptyMessages.viewerNoRequests : emptyMessages.received;
    case "all":
      return disabled ? emptyMessages.viewerNoRequests : emptyMessages.all;
    default:
      return "";
  }
};

const renderUserCard = (
  subType: string,
  otherUser: EnhancedPublicUser,
  onViewRouteClick: (user: User, otherUser: PublicUser) => void,
  onCardClick: (userId: string) => void,
  selectedUser: EnhancedPublicUser | null,
  onViewRequest: (userId: string) => void,
  isUnread: boolean,
  latestMessage: Message | undefined,
  handleMobileExpand?: (userId?: string) => void,
  mobileSelectedUser?: string | null,
  onConnectClose?: (action: string) => void,
): React.JSX.Element => {
  const handleClick = () => onCardClick(otherUser.id);

  /**
   * Which of this card's two roles in the explore list it is playing.
   *
   * Compared against the card's own id rather than read for truthiness. The
   * list above is already filtered down to the selection when one exists, so
   * the two agree today - but "is this the expanded card" is the question the
   * variant answers, and asking it of the wrong card is exactly what
   * `ConnectCardVariant` exists to prevent. `portal` is not reachable from
   * here; `MapConnectPortal` sets it.
   */
  const variant: ConnectCardVariant =
    mobileSelectedUser === otherUser.id ? "detail" : "list";

  switch (subType) {
    case "recommendations":
      return (
        <ConnectCard
          key={otherUser.id}
          otherUser={otherUser}
          onViewRouteClick={onViewRouteClick}
          onViewRequest={onViewRequest}
          handleMobileExpand={handleMobileExpand}
          variant={variant}
          onClose={onConnectClose}
        />
      );
    case "favorites":
      return (
        <ConnectCard
          key={otherUser.id}
          otherUser={otherUser}
          onViewRouteClick={onViewRouteClick}
          onViewRequest={onViewRequest}
          handleMobileExpand={handleMobileExpand}
          variant={variant}
          onClose={onConnectClose}
        />
      );
    case "sent":
      if (otherUser.outgoingRequest) {
        return (
          <SentCard
            key={otherUser.id}
            otherUser={otherUser}
            onClick={handleClick}
            selectedUser={selectedUser}
            isUnread={isUnread}
            latestMessage={latestMessage}
          />
        );
      }
    case "received":
      if (otherUser.incomingRequest) {
        return (
          <ReceivedCard
            key={otherUser.id}
            otherUser={otherUser}
            onClick={handleClick}
            selectedUser={selectedUser}
            isUnread={isUnread}
            latestMessage={latestMessage}
          />
        );
      }
    case "all":
      if (otherUser.incomingRequest) {
        return (
          <ReceivedCard
            key={otherUser.id}
            otherUser={otherUser}
            onClick={handleClick}
            selectedUser={selectedUser}
            isUnread={isUnread}
            latestMessage={latestMessage}
          />
        );
      } else if (otherUser.outgoingRequest) {
        return (
          <SentCard
            key={otherUser.id}
            otherUser={otherUser}
            onClick={handleClick}
            selectedUser={selectedUser}
            isUnread={isUnread}
            latestMessage={latestMessage}
          />
        );
      }
    default:
      return <Spinner />;
  }
};

export const SidebarContent = (props: SidebarContentProps) => {
  const user = useContext(UserContext);
  if (!user) return null;

  const sortedUserCards = props.userCardList
    .map((otherUser) => {
      const request = otherUser.incomingRequest || otherUser.outgoingRequest;

      if (!request) {
        return { otherUser, isUnread: false, latestActivityDate: new Date(0) };
      }
      const latestMessage = getLatestMessageForRequest(request, user.id);

      const { isUnread, latestActivityDate } = getCardSortingData(
        user.id,
        request,
        latestMessage,
      );

      return { otherUser, isUnread, latestActivityDate, latestMessage };
    })
    .sort((a, b) => {
      return b.latestActivityDate.getTime() - a.latestActivityDate.getTime();
    });

  /**
   * The mobile detail state shows one card, so the list collapses to it.
   *
   * No `isMobile &&` guard in front of it. The page derives the value through
   * `resolveMobileSelectedUser`, so a non-null value already implies a mobile
   * viewport and this component needs to know nothing about the viewport -
   * which is why `useIsMobile` does not appear in it.
   */
  const filteredSortedUserCards = props.mobileSelectedUser
    ? sortedUserCards.filter(
        ({ otherUser }) => otherUser.id === props.mobileSelectedUser,
      )
    : sortedUserCards;

  /**
   * The rider-demand notice, or nothing.
   *
   * Built once and painted into both empty branches below - the Viewer-mode
   * copy and the ordinary "no results" copy - because they are the same
   * moment reached by two different routes, and a reader who sees one never
   * sees the other.
   *
   * **Gated on the sub-tab here, not inside the notice.** `viewerModeHidesCards`
   * is reused rather than `subType === "recommendations"` written out, for the
   * same reason the branch below gives: it is the one predicate that says
   * which tab is discovery, and a second spelling of it is a second thing to
   * keep in step. An empty favorites or requests list is not evidence about
   * driver supply and must not carry this.
   *
   * `role` comes from the signed-in user's own context, not from the list.
   */
  const demandNotice = viewerModeHidesCards(props.subType) ? (
    <RiderDemandNotice
      count={props.riderDemandCount}
      role={user.role}
      surface="empty-recommendations"
      className="mt-4"
    />
  ) : null;

  const renderedUserCards = filteredSortedUserCards.map(
    ({ otherUser, isUnread, latestMessage }) =>
      renderUserCard(
        props.subType,
        otherUser,
        props.onViewRouteClick,
        props.onCardClick,
        props.selectedUser,
        props.onViewRequest,
        isUnread,
        !latestMessage ? undefined : latestMessage,
        props.handleMobileExpand,
        props.mobileSelectedUser,
        props.onConnectClose,
      ),
  );

  return (
    <div className="relative h-full px-3.5">
      <div
        className={`relative h-full ${props.mobileSelectedUser ? "overflow-hidden" : "overflow-y-scroll"} scrollbar scrollbar-thumb-busy-red scrollbar-track-rounded-full scrollbar-thumb-rounded-full scrollbar-track-stone-100 pb-32`}
      >
        {/* Order matters. Viewer mode comes first because it is a role, not a
            load result - a VIEWER has no use for a retry on a list they cannot
            act on. Then failure, then loading, and only then "nothing here".

            The condition goes through `viewerModeHidesCards` rather than an
            inline `subType !== "favorites"`, which would sweep up the three
            Requests tabs and leave a VIEWER unable to reach - or withdraw - a
            request they had already sent. Requests fall through to the card
            list; only recommendations are replaced by copy. */}
        {props.disabled && viewerModeHidesCards(props.subType) ? (
          <div className="m-4 text-center text-lg font-light">
            {emptyMessage(props.subType, props.disabled)}
            {demandNotice}
          </div>
        ) : props.loadState.status === "error" ? (
          <QueryError
            subject={errorSubject(props.subType)}
            onRetry={props.loadState.retry}
          />
        ) : props.loadState.status === "loading" ? (
          <div className="m-4 flex justify-center">
            <Spinner />
          </div>
        ) : props.userCardList.length === 0 ? (
          <div className="m-4 text-center text-lg font-light">
            {emptyMessage(props.subType, props.disabled)}
            {demandNotice}
          </div>
        ) : (
          renderedUserCards
        )}
      </div>
    </div>
  );
};
