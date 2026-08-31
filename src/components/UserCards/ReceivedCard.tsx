import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import { UserCard } from "./UserCard";
import { useContext } from "react";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { counterpartLabel } from "../Sidebar/viewerAccess";
import { Message } from "../../utils/types";
import React from "react";

interface ReceivedCardProps {
  otherUser: EnhancedPublicUser;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  onClick: () => void;
  selectedUser: EnhancedPublicUser | null;
  isUnread: boolean;
  latestMessage?: Message;
}
export const ReceivedCard = (props: ReceivedCardProps): React.JSX.Element => {
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

  // The activation target is now `UserCard`'s own stretched <button>
  // (SCRUM-279). This used to be a `role="button"` div wrapped *around*
  // `UserCard`, which made the favourite star a focusable descendant of a
  // widget role — `nested-interactive` — and meant a click on the star bubbled
  // up here and opened the conversation as a side effect.
  //
  // `isCounterpart` is always true on a request card, so this resolves to the
  // preferred name today for every reader including a VIEWER (SCRUM-316). It
  // still goes through `counterpartLabel` rather than reading `preferredName`
  // directly, so that if the disclosure rule ever narrows, the button's
  // `aria-label` narrows with it instead of quietly announcing a name the card
  // has stopped showing. `ConnectCard` is where that rule actually bites.
  const label = counterpartLabel({
    viewerRole: user?.role ?? "",
    isCounterpart: true,
    preferredName: props.otherUser.preferredName,
    role: props.otherUser.role,
  });

  return (
    <UserCard
      otherUser={props.otherUser}
      isCounterpart
      onClick={props.onClick}
      onClickLabel={`Open conversation with ${label}`}
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
