import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import { UserCard } from "./UserCard";
import { useEffect, useContext, useState } from "react";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { createPortal } from "react-dom";
import ReceivedRequestModal from "../Modals/ReceivedRequestModal";
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
  const [showModal, setShowModal] = useState(false);

  // The request stays in this list even when the pair can no longer carpool,
  // so the card carries the reason (SCRUM-296). `user` is never a VIEWER here -
  // the Requests tab renders the Viewer-mode copy instead of any cards - so
  // this cannot show a name UserCard would otherwise withhold.
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
          No aria-label - the card's own text supplies the accessible name, so
          this cannot leak a name that UserCard deliberately hides from
          VIEWER-role users. */}
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
      {showModal &&
        user &&
        props.otherUser.incomingRequest &&
        createPortal(
          <ReceivedRequestModal
            user={user}
            otherUser={props.otherUser}
            onClose={() => setShowModal(false)}
            req={props.otherUser.incomingRequest}
          />,
          document.body,
        )}
    </>
  );
};
