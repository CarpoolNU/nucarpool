import React, { useContext } from "react";
import { EnhancedPublicUser } from "../../utils/types";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { AiOutlineUser } from "react-icons/ai";
import Image from "next/image";
import useProfileImage from "../../utils/useProfileImage";
import useIsMobile from "../../utils/useIsMobile";
import { messageHeaderControls } from "./messageHeaderControls";

/**
 * How a button in flight looks. The same `opacity-40` `SendBar` already uses, so
 * the two in-flight states in the messaging UI read the same.
 */
const DISABLED_CLASS = "cursor-not-allowed opacity-40 hover:bg-inherit";

interface MessageHeaderProps {
  selectedUser: EnhancedPublicUser;
  onAccept: () => void;
  onReject: () => void;
  onClose: (userId: string) => void;
  groupId: string | null;
  /** True while a request mutation is in flight. */
  isMutating?: boolean;
}

const MessageHeader = ({
  selectedUser,
  onAccept,
  onReject,
  onClose,
  groupId,
  isMutating = false,
}: MessageHeaderProps) => {
  // Which controls this pair's state offers. The rule lives in
  // `messageHeaderControls` so it can be tested — this component cannot be,
  // there being no jsdom or React testing library here.
  //
  // `none` for a pair already in the same group is SCRUM-362: that state used
  // to offer a "Leave Conversation" button wired to `onReject`, so pressing it
  // deleted their accepted request and destroyed a thread they could not get
  // back. See that module for why it was removed rather than repaired.
  const controls = messageHeaderControls({
    incomingStatus: selectedUser.incomingRequest?.status,
    outgoingStatus: selectedUser.outgoingRequest?.status,
    groupId,
    otherCarpoolId: selectedUser.carpoolId,
  });

  const hasIncomingRequest = controls.kind === "respond";
  const hasOutgoingRequest = controls.kind === "withdraw";

  // A pending request whose two parties can no longer carpool - either of them
  // switched role after it was sent - is no longer hidden from the Requests tab,
  // because hiding it never stopped it blocking new requests. It
  // is still not acceptable, so Accept is replaced by the reason rather than
  // left to fail on press. Reject and Withdraw stay: clearing the request is
  // the way out, and it was the absence of any way to reach them that made this
  // a dead end.
  const user = useContext(UserContext);
  const roleMismatch =
    user && (hasIncomingRequest || hasOutgoingRequest)
      ? roleMismatchExplanation(
          user.role,
          selectedUser.role,
          selectedUser.preferredName,
        )
      : null;

  const ismobile = useIsMobile();

  const handleClose = () => {
    onClose("");
  };
  const {
    profileImageUrl,
    imageLoadError,
    isLoading: isProfileImageLoading,
  } = useProfileImage(selectedUser.id);

  if (ismobile) {
    return (
      <div className="relative flex items-center border-b border-gray-200 bg-white py-4">
        <button
          type="button"
          className="absolute left-4 text-gray-600"
          onClick={handleClose}
          aria-label="Back to conversations"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        <div className="w-full text-center">
          <span className="font-montserrat pr-10 pl-10 font-semibold sm:text-lg md:text-xl lg:text-2xl">
            {selectedUser.preferredName}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-b border-gray-200 bg-white p-8">
      <div className="flex items-center">
        {isProfileImageLoading ? (
          <div className="h-20 w-20 rounded-full bg-gray-200" />
        ) : profileImageUrl && !imageLoadError ? (
          <Image
            src={profileImageUrl}
            alt={`${selectedUser.preferredName}'s Profile Image`}
            width={80}
            height={80}
            className="h-20 w-20 rounded-full object-contain"
          />
        ) : (
          <AiOutlineUser className="h-20 w-20 rounded-full bg-gray-200" />
        )}

        <span className="font-montserrat pr-10 pl-10 font-semibold sm:text-lg md:text-xl lg:text-2xl">
          {selectedUser.preferredName}
        </span>
      </div>
      <div className="relative flex items-center justify-between">
        {hasIncomingRequest && (
          <>
            {roleMismatch && (
              <p className="font-montserrat mr-10 max-w-sm text-sm text-gray-700">
                {roleMismatch}
              </p>
            )}
            <button
              onClick={onReject}
              disabled={isMutating}
              className={`mr-10 rounded-lg border-2 border-black bg-white py-2 text-center text-lg font-medium text-black hover:bg-gray-100 sm:px-8 md:px-12 lg:px-20 ${
                isMutating ? DISABLED_CLASS : ""
              }`}
            >
              Reject
            </button>
            {!roleMismatch && (
              <button
                onClick={onAccept}
                disabled={isMutating}
                className={`border-northeastern-red bg-northeastern-red mr-10 rounded-lg border-2 py-2 text-center text-lg font-medium text-white hover:bg-red-700 sm:px-8 md:px-12 lg:px-20 ${
                  isMutating ? DISABLED_CLASS : ""
                }`}
              >
                Accept
              </button>
            )}
          </>
        )}
        {hasOutgoingRequest && (
          <>
            {roleMismatch && (
              <p className="font-montserrat mr-10 max-w-sm text-sm text-gray-700">
                {roleMismatch}
              </p>
            )}
            <button
              onClick={onReject}
              disabled={isMutating}
              className={`mr-10 rounded-lg border-2 border-black bg-white py-2 text-center text-lg font-medium text-black hover:bg-gray-100 md:px-12 lg:px-20 ${
                isMutating ? DISABLED_CLASS : ""
              }`}
            >
              Withdraw Request
            </button>
          </>
        )}

        {/*
          A pair already carpooling together get no button here, only the
          close control below. There used to be a "Leave Conversation" button
          in this slot on `onReject`, which deleted their accepted request and
          with it a thread they could not recreate. SCRUM-362 removed it: `×`
          already closes the panel, and the Group page already leaves the
          carpool.
        */}
        <button
          onClick={handleClose}
          className="h-14 w-14 cursor-pointer items-center justify-center text-3xl text-black"
          aria-label="Close"
        >
          &times;
        </button>
      </div>
    </div>
  );
};

export default MessageHeader;
