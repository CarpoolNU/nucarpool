import React, { useContext } from "react";
import { EnhancedPublicUser } from "../../utils/types";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { AiOutlineUser } from "react-icons/ai";
import Image from "next/image";
import useProfileImage from "../../utils/useProfileImage";
import useIsMobile from "../../utils/useIsMobile";
import { HeaderControls, messageHeaderControls } from "./messageHeaderControls";

/**
 * How a button in flight looks. The same `opacity-40` `SendBar` already uses, so
 * the two in-flight states in the messaging UI read the same.
 */
const DISABLED_CLASS = "cursor-not-allowed opacity-40 hover:bg-inherit";

/**
 * What each layout dresses the request controls in.
 *
 * The controls themselves — which ones apply, what they are called, when
 * Accept is withheld — are one component shared by both branches, because
 * having them in only one branch is exactly how mobile ended up with no way to
 * accept, reject or withdraw a request at all. Only the class names differ,
 * and they differ enough to be worth naming: the desktop buttons are sized for
 * a header bar with room to spare, and at 375px `text-lg` with `lg:px-20`
 * would not fit two of them on a line.
 */
type ControlClasses = {
  /** The role-mismatch explanation, where there is one. */
  explanation: string;
  /** Reject, and Withdraw Request — the same outlined button in both states. */
  secondary: string;
  /** Accept. */
  primary: string;
};

/**
 * Unchanged from what the desktop header already rendered, with one
 * deliberate exception: the outlined button keeps `sm:px-8` in both states.
 * Reject carried it and Withdraw Request did not, so a withdrawal between
 * 640px and 834px — the band where `sm` applies and `md` does not — drew with
 * no horizontal padding at all. One button in one slot cannot have two
 * paddings, and the padded one is the intended look.
 */
const DESKTOP_CONTROL_CLASSES: ControlClasses = {
  explanation: "font-montserrat mr-10 max-w-sm text-sm text-gray-700",
  secondary:
    "mr-10 rounded-lg border-2 border-black bg-white py-2 text-center text-lg font-medium text-black hover:bg-gray-100 sm:px-8 md:px-12 lg:px-20",
  primary:
    "border-northeastern-red bg-northeastern-red mr-10 rounded-lg border-2 py-2 text-center text-lg font-medium text-white hover:bg-red-700 sm:px-8 md:px-12 lg:px-20",
};

/**
 * A row under the counterpart's name, inside the header the conversation
 * already opens with.
 *
 * `flex-1` rather than a fixed width because the two states put a different
 * number of buttons on the row: Reject and Accept share it, and Withdraw
 * Request has it to itself. The explanation takes `w-full` so it wraps above
 * them instead of competing for the same line — on desktop the container is a
 * single row and it sits alongside, which is the layout that branch had.
 *
 * Nothing here asserts this fits. jsdom does no layout, so the test file's
 * assertions are about reachability; the vertical cost of a second row in a
 * panel that also holds the tab strip, message list and send bar is a real
 * device's question.
 */
const MOBILE_CONTROL_CLASSES: ControlClasses = {
  explanation: "font-montserrat w-full text-sm text-gray-700",
  secondary:
    "flex-1 rounded-lg border-2 border-black bg-white px-4 py-2 text-center text-base font-medium text-black hover:bg-gray-100",
  primary:
    "border-northeastern-red bg-northeastern-red flex-1 rounded-lg border-2 px-4 py-2 text-center text-base font-medium text-white hover:bg-red-700",
};

interface RequestControlsProps {
  controls: HeaderControls;
  /** Why Accept is withheld, or `null` when the pair still fit. */
  roleMismatch: string | null;
  onAccept: () => void;
  onReject: () => void;
  isMutating: boolean;
  classes: ControlClasses;
}

/**
 * The request controls for one pair, in whichever layout asked for them.
 *
 * Returns a fragment rather than its own container so each branch keeps its
 * own arrangement — the desktop header puts these in the same flex row as its
 * `×`, and the mobile header gives them a row of their own.
 *
 * `none` renders nothing, and that is load-bearing: a pair already carpooling
 * together get no control here. The slot used to hold a "Leave Conversation"
 * button wired to the same `onReject` handler as Reject and Withdraw, so
 * pressing it deleted their accepted request and destroyed a thread they could
 * not get back. See `messageHeaderControls` for why it was removed rather than
 * repaired.
 */
const RequestControls = ({
  controls,
  roleMismatch,
  onAccept,
  onReject,
  isMutating,
  classes,
}: RequestControlsProps) => {
  if (controls.kind === "none") {
    return null;
  }

  return (
    <>
      {roleMismatch && <p className={classes.explanation}>{roleMismatch}</p>}
      {/*
        One button for two states, because clearing the request is the same
        act from either end and the label is the only difference. It stays
        available under a role mismatch: clearing is the way out of that state,
        and having no route to it was its own dead end.
      */}
      <button
        onClick={onReject}
        disabled={isMutating}
        className={`${classes.secondary} ${isMutating ? DISABLED_CLASS : ""}`}
      >
        {controls.kind === "withdraw" ? "Withdraw Request" : "Reject"}
      </button>
      {controls.kind === "respond" && !roleMismatch && (
        <button
          onClick={onAccept}
          disabled={isMutating}
          className={`${classes.primary} ${isMutating ? DISABLED_CLASS : ""}`}
        >
          Accept
        </button>
      )}
    </>
  );
};

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
  // `messageHeaderControls` so a test can state it as a table rather than
  // infer it from a render, and this value is computed once for both layouts:
  // it was already computed above the mobile branch when that branch rendered
  // none of it, which is how the table stayed right while a whole viewport had
  // no way to answer a request. `MessageHeader.test.tsx` is the render-level
  // half of that, and asserts both branches.
  //
  // `none` for a pair already in the same group is that state used
  // to offer a "Leave Conversation" button wired to `onReject`, so pressing it
  // deleted their accepted request and destroyed a thread they could not get
  // back. See that module for why it was removed rather than repaired.
  const controls = messageHeaderControls({
    incomingStatus: selectedUser.incomingRequest?.status,
    outgoingStatus: selectedUser.outgoingRequest?.status,
    groupId,
    otherCarpoolId: selectedUser.carpoolId,
  });

  // A pending request whose two parties can no longer carpool - either of them
  // switched role after it was sent - is no longer hidden from the Requests tab,
  // because hiding it never stopped it blocking new requests. It
  // is still not acceptable, so Accept is replaced by the reason rather than
  // left to fail on press. Reject and Withdraw stay: clearing the request is
  // the way out, and it was the absence of any way to reach them that made this
  // a dead end.
  const user = useContext(UserContext);
  const roleMismatch =
    user && controls.kind !== "none"
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
  /*
    Only the desktop branch below draws an avatar, so only it pays for one.
    Ungated, this fired an authenticated presigned-URL request - and an S3
    `HeadObject` behind it - on every mobile conversation opened, for a picture
    the mobile branch renders nowhere. `staleTime` made reopening the same
    conversation free, so the waste was one round trip per distinct
    conversation rather than per open.

    The call cannot simply move inside the branch: rules of hooks forbid a
    conditional call, and the two branches are one component because they do
    share things - the request controls, the role-mismatch copy and the
    mutation state. So the caller states what it will render instead, and
    `MessageHeader.avatarRequest.test.tsx` watches the network layer to keep
    that honest: a render-time spy cannot tell this fix from a no-op, because
    it fires whether or not the query is enabled.
  */
  const {
    profileImageUrl,
    imageLoadError,
    isLoading: isProfileImageLoading,
  } = useProfileImage(selectedUser.id, { enabled: !ismobile });

  if (ismobile) {
    return (
      <div className="border-b border-gray-200 bg-white">
        <div className="relative flex items-center py-4">
          <button
            type="button"
            /* The padding is the tap target, not decoration.
               The arrow stays `h-6`, so 2.5 + 6 + 2.5 = 11 spacing units =
               44px - the size Apple's HIG and WCAG 2.5.5 ask of a touch
               control, and the figure the explore sheet's handle, the map
               recentre control and the map legend already use. It was a bare
               24px icon in a button with no padding, which made the icon the
               whole target. This is the only way out of a conversation on a
               phone: the desktop header's close control is in the branch
               below, which mobile returns before reaching.

               `left-1.5` rather than the four units it sat at before, so the
               arrow does not move: 1.5 + 2.5 = 4, the offset it had when the
               button was only the icon. The target grows outwards from where
               the user already aims instead of pushing the arrow 10px
               inboard, and the 44px box ends up nearer the screen edge, where
               the thumb is. The old offset is deliberately not spelled out as
               a class here - Tailwind scans this file for class-like strings
               and would emit whichever one a comment names, and nothing uses
               that one any more.

               `flex` keeps that arithmetic exact: an inline SVG contributes a
               line box, so without it the height is the icon plus whatever
               leading the font adds rather than icon plus padding.

               Do not trade the padding away to make the arrow look smaller -
               shrink the `h-6` span and leave the padding holding the target
               open. */
            className="absolute left-1.5 flex items-center justify-center p-2.5 text-gray-600"
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

        {/*
          Gated on the container rather than left to `RequestControls`
          returning null, so a conversation with nothing to answer - most of
          them - costs no padding.
        */}
        {controls.kind !== "none" && (
          <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
            <RequestControls
              controls={controls}
              roleMismatch={roleMismatch}
              onAccept={onAccept}
              onReject={onReject}
              isMutating={isMutating}
              classes={MOBILE_CONTROL_CLASSES}
            />
          </div>
        )}
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
        <RequestControls
          controls={controls}
          roleMismatch={roleMismatch}
          onAccept={onAccept}
          onReject={onReject}
          isMutating={isMutating}
          classes={DESKTOP_CONTROL_CLASSES}
        />

        {/*
          A pair already carpooling together get no button here, only the
          close control below. There used to be a "Leave Conversation" button
          in this slot on `onReject`, which deleted their accepted request and
          with it a thread they could not recreate. It was removed: `×`
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
