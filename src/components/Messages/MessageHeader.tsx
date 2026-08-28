import React, { useContext } from "react";
import { RequestStatus } from "@prisma/client";
import { EnhancedPublicUser } from "../../utils/types";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { AiOutlineUser } from "react-icons/ai";
import Image from "next/image";
import useProfileImage from "../../utils/useProfileImage";
import useIsMobile from "../../utils/useIsMobile";

/**
 * How a button in flight looks. The same `opacity-40` `SendBar` already uses, so
 * the two in-flight states in the messaging UI read the same (SCRUM-293).
 */
const DISABLED_CLASS = "cursor-not-allowed opacity-40 hover:bg-inherit";

interface MessageHeaderProps {
  selectedUser: EnhancedPublicUser;
  onAccept: () => void;
  onReject: () => void;
  onClose: (userId: string) => void;
  groupId: string | null;
  /** True while a request mutation is in flight (SCRUM-293). */
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
  // Only a request still awaiting an answer offers Accept, Reject or Withdraw
  // (SCRUM-228). An accepted request stays attached to the user so the pair keep
  // their conversation, but it is no longer something to respond to. This used
  // to be a plain presence check, which is why an accepted request kept showing
  // its Accept button; the group comparison below was standing in for the status
  // the row did not carry.
  const hasIncomingRequest =
    selectedUser.incomingRequest?.status === RequestStatus.PENDING;
  const hasOutgoingRequest =
    selectedUser.outgoingRequest?.status === RequestStatus.PENDING;

  // A pending request whose two parties can no longer carpool - either of them
  // switched role after it was sent - is no longer hidden from the Requests tab
  // (SCRUM-296), because hiding it never stopped it blocking new requests. It
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
      <div className="relative flex items-center border-b bg-white py-4">
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
          <span className="pl-10 pr-10 font-montserrat font-semibold sm:text-lg md:text-xl lg:text-2xl">
            {selectedUser.preferredName}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-b bg-white p-8">
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

        <span className="pl-10 pr-10 font-montserrat font-semibold sm:text-lg md:text-xl lg:text-2xl">
          {selectedUser.preferredName}
        </span>
      </div>
      <div className="relative flex items-center justify-between">
        {hasIncomingRequest &&
          (!groupId || selectedUser.carpoolId !== groupId) && (
            <>
              {roleMismatch && (
                <p className="mr-10 max-w-sm font-montserrat text-sm text-gray-700">
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
                  className={`mr-10 rounded-lg border-2 border-northeastern-red bg-northeastern-red py-2 text-center text-lg font-medium text-white hover:bg-red-700 sm:px-8 md:px-12 lg:px-20 ${
                    isMutating ? DISABLED_CLASS : ""
                  }`}
                >
                  Accept
                </button>
              )}
            </>
          )}
        {hasOutgoingRequest &&
          !hasIncomingRequest &&
          (!groupId || selectedUser.carpoolId !== groupId) && (
            <>
              {roleMismatch && (
                <p className="mr-10 max-w-sm font-montserrat text-sm text-gray-700">
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
        {groupId && selectedUser.carpoolId === groupId && (
          <button
            onClick={onReject}
            disabled={isMutating}
            className={`mr-10 rounded-lg border-2 border-black bg-white py-2 text-center text-lg font-medium text-black hover:bg-gray-100 md:px-12 lg:px-20 ${
              isMutating ? DISABLED_CLASS : ""
            }`}
          >
            Leave Conversation
          </button>
        )}

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
