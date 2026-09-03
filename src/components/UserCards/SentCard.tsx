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
  // so the card carries the reason.
  //
  // `user` **can** be a VIEWER here: the Requests tab used to
  // render Viewer-mode copy in place of every card, which left a VIEWER unable
  // to withdraw a request they had sent. The name shows either way now -
  // SCRUM-323 removed the Viewer-mode name withholding entirely, so the notice
  // below and the card's heading name the same person.
  const roleMismatch = user
    ? roleMismatchExplanation(
        user.role,
        props.otherUser.role,
        props.otherUser.preferredName,
      )
    : null;

  // The activation target is now `UserCard`'s own stretched <button>.
  // This used to be a `role="button"` div wrapped *around*
  // `UserCard`, which made the favourite star a focusable descendant of a
  // widget role — `nested-interactive` — and meant a click on the star bubbled
  // up here and opened the conversation as a side effect.

  return (
    <UserCard
      otherUser={props.otherUser}
      onClick={props.onClick}
      onClickLabel={`Open conversation with ${props.otherUser.preferredName}`}
      isSelected={props.selectedUser?.id === props.otherUser.id}
      message={props.latestMessage?.content}
      notice={roleMismatch ?? undefined}
      isUnread={props.isUnread}
      classname={
        props.selectedUser?.id === props.otherUser.id
          ? "border-l-northeastern-red drop-shadow-lg"
          : ""
      }
    />
  );
};
