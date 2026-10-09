import { useContext } from "react";
import { EnhancedPublicUser, Message } from "../../utils/types";
import { UserContext } from "../../utils/userContext";
import { requestUnavailableExplanation } from "../../utils/roleCompatibility";
import { UserCard } from "./UserCard";
import React from "react";

interface SentCardProps {
  otherUser: EnhancedPublicUser;
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
  // `requestUnavailableExplanation` rather than `roleMismatchExplanation`,
  // because a counterpart who has paused their search now reaches this list
  // too and their role says nothing about why. A compatible pair
  // where one has paused would otherwise get `null` here — a blank card with
  // no hint of why Accept refuses.
  //
  // `user` **can** be a VIEWER here: the Requests tab renders real cards for
  // one, because Viewer-mode copy in their place leaves a VIEWER unable to
  // withdraw a request they have sent. The name shows either way - Viewer mode
  // withholds no name at all - so the notice below and the card's heading name
  // the same person.
  const unavailable = user
    ? requestUnavailableExplanation(user.role, props.otherUser)
    : null;

  // The activation target is `UserCard`'s own stretched <button>. A
  // `role="button"` div wrapped *around* `UserCard` would make the favourite
  // star a focusable descendant of a widget role — `nested-interactive` — and
  // a click on the star would bubble up here and open the conversation as a
  // side effect.

  return (
    <UserCard
      otherUser={props.otherUser}
      onClick={props.onClick}
      onClickLabel={`Open conversation with ${props.otherUser.preferredName}`}
      isSelected={props.selectedUser?.id === props.otherUser.id}
      message={props.latestMessage?.content}
      notice={unavailable ?? undefined}
      isUnread={props.isUnread}
      classname={
        props.selectedUser?.id === props.otherUser.id
          ? "border-l-northeastern-red drop-shadow-lg"
          : ""
      }
    />
  );
};
