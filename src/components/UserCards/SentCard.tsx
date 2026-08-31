import { useContext } from "react";
import {
  EnhancedPublicUser,
  Message,
  PublicUser,
  User,
} from "../../utils/types";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { UserCard } from "./UserCard";
import React from "react";

interface SentCardProps {
  otherUser: EnhancedPublicUser;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  onClick: () => void;
  selectedUser: EnhancedPublicUser | null;
  isUnread: boolean;
  latestMessage?: Message;
}

export const SentCard = (props: SentCardProps): React.JSX.Element => {
  const user = useContext(UserContext);

  // The request stays in this list even when the pair can no longer carpool,
  // so the card carries the reason (SCRUM-296).
  //
  // `user` **can** be a VIEWER here, as of SCRUM-316: the Requests tab used to
  // render Viewer-mode copy in place of every card, which left a VIEWER unable
  // to withdraw a request they had sent. `isCounterpart` below is what lets the
  // name still show - withholding it would be pointless when the notice names
  // them anyway, and would make several requests indistinguishable.
  const roleMismatch = user
    ? roleMismatchExplanation(
        user.role,
        props.otherUser.role,
        props.otherUser.preferredName,
      )
    : null;

  return (
    <>
      {/* Not a <button>: UserCard embeds a MUI <Rating>, and a button may not
          contain other interactive controls. A roled, focusable region gives
          keyboard users the same activation without that nesting (SCRUM-254).
          No aria-label - the card's own text supplies the accessible name. */}
      <div
        role="button"
        tabIndex={0}
        aria-current={props.selectedUser?.id === props.otherUser.id}
        onClick={props.onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onClick();
          }
        }}
        className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-northeastern-red"
      >
        <UserCard
          otherUser={props.otherUser}
          isCounterpart
          message={props.latestMessage?.content}
          notice={roleMismatch ?? undefined}
          isUnread={props.isUnread}
          classname={
            props.selectedUser?.id === props.otherUser.id
              ? "border-l-northeastern-red drop-shadow-lg"
              : ""
          }
        />
      </div>
    </>
  );
};
