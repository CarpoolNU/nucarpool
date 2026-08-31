import React, { useContext } from "react";
import {
  EnhancedPublicUser,
  Message,
  PublicUser,
  User,
} from "../../utils/types";
import Spinner from "../Spinner";
import { ConnectCard } from "../UserCards/ConnectCard";
import { ReceivedCard } from "../UserCards/ReceivedCard";
import { SentCard } from "../UserCards/SentCard";
import {
  getCardSortingData,
  getLatestMessageForRequest,
} from "../../utils/latestMessage";
import { UserContext } from "../../utils/userContext";
import useIsMobile from "../../utils/useIsMobile";
import { QueryState } from "../../utils/queryState";
import { QueryError } from "../QueryError";
import { viewerModeHidesCards } from "./viewerAccess";

interface SidebarContentProps {
  subType: string;
  userCardList: EnhancedPublicUser[];
  /**
   * Whether the list behind this tab loaded. Without it an empty
   * `userCardList` meant three different things - loading, failed, and genuinely
   * empty - and all three rendered the same "no results" copy (SCRUM-241).
   */
  loadState: QueryState;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  disabled: boolean;
  onCardClick: (userId: string) => void;
  selectedUser: EnhancedPublicUser | null;
  onViewRequest: (userId: string) => void;
  mobileSelectedUser?: string | null;
  handleMobileExpand?: (userId?: string) => void;
}

const emptyMessages = {
  recommendations: `We're unable to find any recommendations for you right now.
  We recommend reviewing your profile to make sure all information you've entered is accurate!`,
  disabledRec:
    "You are currently in Viewer mode, to get recommendations select Driver or Rider in profile.",
  /**
   * A VIEWER with no requests at all. The non-Viewer copy below points at the
   * recommendations sidebar, which is the one place Viewer mode genuinely does
   * block, so it would be misdirection here (SCRUM-316).
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
): React.JSX.Element => {
  const handleClick = () => onCardClick(otherUser.id);
  switch (subType) {
    case "recommendations":
      return (
        <ConnectCard
          key={otherUser.id}
          otherUser={otherUser}
          onViewRouteClick={onViewRouteClick}
          onViewRequest={onViewRequest}
          handleMobileExpand={handleMobileExpand}
          mobileSelectedUser={mobileSelectedUser}
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
          mobileSelectedUser={mobileSelectedUser}
        />
      );
    case "sent":
      if (otherUser.outgoingRequest) {
        return (
          <SentCard
            key={otherUser.id}
            otherUser={otherUser}
            onViewRouteClick={onViewRouteClick}
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
            onViewRouteClick={onViewRouteClick}
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
            onViewRouteClick={onViewRouteClick}
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
            onViewRouteClick={onViewRouteClick}
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
  const isMobile = useIsMobile();
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

  const filteredSortedUserCards =
    isMobile && props.mobileSelectedUser
      ? sortedUserCards.filter(
          ({ otherUser }) => otherUser.id === props.mobileSelectedUser,
        )
      : sortedUserCards;

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
      ),
  );

  return (
    <div className="relative h-full px-3.5">
      <div
        className={`relative h-full ${isMobile && props.mobileSelectedUser === null ? "overflow-y-scroll" : isMobile && props.mobileSelectedUser !== null ? "overflow-hidden" : "overflow-y-scroll"} pb-32 scrollbar scrollbar-track-stone-100 scrollbar-thumb-busy-red scrollbar-track-rounded-full scrollbar-thumb-rounded-full`}
      >
        {/* Order matters. Viewer mode comes first because it is a role, not a
            load result - a VIEWER has no use for a retry on a list they cannot
            act on. Then failure, then loading, and only then "nothing here".

            `viewerModeHidesCards` is what this used to test inline as
            `subType !== "favorites"`, which swept up the three Requests tabs
            and left a VIEWER unable to reach - or withdraw - a request they had
            already sent (SCRUM-316). Requests now fall through to the card
            list; only recommendations are replaced by copy. */}
        {props.disabled && viewerModeHidesCards(props.subType) ? (
          <div className="m-4 text-center text-lg font-light">
            {emptyMessage(props.subType, props.disabled)}
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
          </div>
        ) : (
          renderedUserCards
        )}
      </div>
    </div>
  );
};
