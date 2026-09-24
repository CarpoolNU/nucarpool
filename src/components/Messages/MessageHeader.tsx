import React, { useContext, useState } from "react";
import { EnhancedPublicUser } from "../../utils/types";
import { UserContext } from "../../utils/userContext";
import { roleMismatchExplanation } from "../../utils/roleCompatibility";
import { AiOutlineUser } from "react-icons/ai";
import Image from "next/image";
import useProfileImage from "../../utils/useProfileImage";
import useIsMobile from "../../utils/useIsMobile";
import { HeaderControls, messageHeaderControls } from "./messageHeaderControls";
import UserActionsMenu from "../UserActions/UserActionsMenu";

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

/**
 * What the confirmation step asks, per state of the button that clears the
 * request.
 *
 * Both states delete the `Request` row and take the conversation with it -
 * they are one button on one `onReject`, and the label is the only difference
 * - so both are confirmed. SCRUM-468 asked for the Reject half, where the
 * hazard is proximity to Accept; Withdraw Request gets it too because gating
 * one state of one button out of a confirmation is a conditional with nothing
 * behind it, and a full-width single-press control that destroys a thread is
 * the same defect with a different label.
 *
 * Accept is deliberately not confirmed: it already refuses a second press
 * through `isMutating`, and SCRUM-468 requires it left alone.
 */
const CONFIRM_PROMPTS: Record<"respond" | "withdraw", string> = {
  respond: "Reject this request? This also deletes the conversation.",
  withdraw: "Withdraw this request? This also deletes the conversation.",
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
  /**
   * Whether the destructive button has been pressed once and is now asking.
   *
   * The two-step in place, rather than a modal, is the idiom
   * `GroupMemberCard` already uses for Delete Group, Leave Group and Remove -
   * reused so destructive confirmation reads the same everywhere instead of
   * this being a third mechanism.
   *
   * The state belongs to this component and not the header, so it cannot
   * outlive the controls: answering the request makes `controls.kind` `none`
   * and unmounts this, and switching conversation remounts it, because both
   * call sites key it on the counterpart's id. A half-confirmed Reject must
   * never be inherited by the next person's request.
   */
  const [isConfirming, setIsConfirming] = useState(false);

  if (controls.kind === "none") {
    return null;
  }

  if (isConfirming) {
    return (
      <>
        {/*
          The prompt takes the explanation's slot, so it wraps above the
          buttons on mobile and sits alongside them on desktop without either
          branch needing a new class. It displaces the role-mismatch text where
          there is one; Cancel brings that back, and the question being asked
          is the more urgent of the two messages.
        */}
        <p className={classes.explanation}>{CONFIRM_PROMPTS[controls.kind]}</p>
        {/*
          Cancel is first, which puts it exactly where the finger that just
          pressed Reject already is. That ordering is the point of the step: an
          impatient second press in the same place - the likeliest way to
          defeat a two-step confirmation - hits Cancel rather than Confirm.
          That works *here* because these two are `flex-1` across a full-width
          row, so first means leftmost and Reject was leftmost too.

          `GroupMemberCard` reaches the same property by stacking its pair with
          Cancel on top, and not by this ordering, because its controls are
          right-aligned in a shrink-wrapped slot under a right-aligned trigger
          - so ordering its row this way would move Confirm *onto* the slot the
          finger just pressed instead of off it. Same rule, opposite
          arrangement; SCRUM-476 has the measurements. Read that comment before
          changing either one to match the other.

          It also takes the *filled* slot, and Confirm the outlined one, which
          is the reverse of what a confirmation usually does. The reason is
          that `primary` here is not a danger colour: `northeastern-red` is the
          brand's, and Accept wears it. A filled red Confirm would therefore
          look like Accept while standing in the place Accept just occupied -
          the strongest possible invitation to the exact mis-tap this step
          exists to stop. Dressing them this way keeps one rule across both
          states of the row: outlined clears the request, filled red is the
          affirmative answer.
        */}
        <button
          onClick={() => setIsConfirming(false)}
          className={classes.primary}
        >
          Cancel
        </button>
        <button
          onClick={() => {
            setIsConfirming(false);
            onReject();
          }}
          disabled={isMutating}
          className={`${classes.secondary} ${isMutating ? DISABLED_CLASS : ""}`}
        >
          Confirm
        </button>
      </>
    );
  }

  return (
    <>
      {roleMismatch && <p className={classes.explanation}>{roleMismatch}</p>}
      {/*
        One button for two states, because clearing the request is the same
        act from either end and the label is the only difference. It stays
        available under a role mismatch: clearing is the way out of that state,
        and having no route to it was its own dead end.

        It asks before it acts. `onReject` runs `requests.delete`, which
        removes the row and the conversation with it, and on mobile this button
        sat a `gap-3` - 12px - from Accept, as two half-width thumb targets
        against a finger's roughly 8px of slop. The gap is 24px now and this is
        two presses; neither alone was enough.
      */}
      <button
        onClick={() => setIsConfirming(true)}
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
  // `none` for a pair already in the same group is deliberate: that state used
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

  // The request this thread belongs to, chosen the way `MessagePanel` chooses
  // it to send, so a report made here snapshots the thread on screen.
  const requestId = (
    selectedUser.incomingRequest || selectedUser.outgoingRequest
  )?.id;
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

          {/* Mirrors the back button on the other edge. The name's `pr-10`
              already keeps it clear of the text. */}
          <div className="absolute right-1.5">
            <UserActionsMenu
              key={selectedUser.id}
              userId={selectedUser.id}
              userName={selectedUser.preferredName}
              requestId={requestId}
              onBlocked={handleClose}
            />
          </div>
        </div>

        {/*
          Gated on the container rather than left to `RequestControls`
          returning null, so a conversation with nothing to answer - most of
          them - costs no padding.
        */}
        {controls.kind !== "none" && (
          /*
            `gap-6` - 24px - and not the `gap-3` this had. Reject and Accept
            are both `flex-1`, so they were two half-width thumb targets 12px
            apart where the desktop pair carry `mr-10`; a destructive and a
            constructive action that close, at that size, is a mis-tap away
            from deleting a request and its conversation. 24px is what
            SCRUM-468 asks for, and it still leaves each button ~160px wide at
            375px.

            The row gap moves with it, which is the intended effect where the
            role-mismatch explanation or the confirmation prompt wraps above
            the buttons.

            jsdom measures none of this - see `testing/viewport.ts`. The test
            file asserts the class as a proxy and says so.
          */
          <div className="flex flex-wrap items-center gap-6 px-4 pb-4">
            <RequestControls
              key={selectedUser.id}
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
    /*
      The full-size chrome is restored only where the panel is tall enough to
      pay for it.

      `p-8` around an 80px avatar is 145px of header, and the panel fills the
      content row beside the header bar - so on a phone in landscape it took
      145 of the 343px that row then was, the tab strip below took 53 more, and
      the conversation was left
      with nothing: `message-content` measured 32px tall, all of it its own
      padding, with `contentHeight` 0 and a `scrollHeight` of 220 behind it.
      Not cramped - a user who opened a thread in landscape saw no messages at
      all, including the one they had just sent (SCRUM-489).

      **The compact values are the base and the full-size ones the override**,
      which is the inversion `DESKTOP_MEDIA_QUERY`'s docblock argues for: a
      `min-` query cannot be negated, so anything stated only as an override is
      unreachable below the threshold. Here it costs nothing, because this
      branch is desktop-only already - `ismobile` returns above, so these base
      classes never reach a phone in portrait.

      **`py-1` is 4px and that is deliberate, not a slip.** The header's height
      is set by the tallest thing in it, and below 56px that is the close
      control beside the name rather than the avatar - so shrinking the avatar
      past `h-14` buys nothing while `py-2` costs 8px that the conversation
      needs. Measured: at 667x375 this leaves `message-content` 83px of content
      height, which is exactly enough for the newest message to be read whole
      (64px for a one-line bubble plus its 16px of margin). `py-2` leaves 75 and
      clips the top 5px of it. The avatar keeps `h-14` for the same arithmetic
      seen from the other side: 56px is free.
    */
    <div className="message-panel-tall:p-8 flex items-center justify-between border-b border-gray-200 bg-white px-2 py-1">
      <div className="flex items-center">
        {isProfileImageLoading ? (
          <div className="message-panel-tall:h-20 message-panel-tall:w-20 h-14 w-14 rounded-full bg-gray-200" />
        ) : profileImageUrl && !imageLoadError ? (
          <Image
            src={profileImageUrl}
            alt={`${selectedUser.preferredName}'s Profile Image`}
            // Unchanged at 80: this is the size the source is *requested* at,
            // not the size it is drawn at, so leaving it alone means the
            // compact avatar is a downscaled 80px image rather than an
            // upscaled 56px one. The classes below decide the box.
            width={80}
            height={80}
            className="message-panel-tall:h-20 message-panel-tall:w-20 h-14 w-14 rounded-full object-contain"
          />
        ) : (
          <AiOutlineUser className="message-panel-tall:h-20 message-panel-tall:w-20 h-14 w-14 rounded-full bg-gray-200" />
        )}

        <span className="font-montserrat pr-10 pl-10 font-semibold sm:text-lg md:text-xl lg:text-2xl">
          {selectedUser.preferredName}
        </span>
      </div>
      <div className="relative flex items-center justify-between">
        {/* Keyed like the mobile branch: the confirmation step lives in
            `RequestControls`, and switching conversation must drop a
            half-answered one rather than carry it to the next person. */}
        <RequestControls
          key={selectedUser.id}
          controls={controls}
          roleMismatch={roleMismatch}
          onAccept={onAccept}
          onReject={onReject}
          isMutating={isMutating}
          classes={DESKTOP_CONTROL_CLASSES}
        />

        {/* Blocking closes the thread, which has just become unavailable
            to both people. Keyed like `RequestControls`, so a Block dialog
            left open cannot carry over to the next person's conversation. */}
        <UserActionsMenu
          key={selectedUser.id}
          userId={selectedUser.id}
          userName={selectedUser.preferredName}
          requestId={requestId}
          onBlocked={handleClose}
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
