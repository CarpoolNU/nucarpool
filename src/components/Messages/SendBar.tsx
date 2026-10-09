import React, { useRef, useState } from "react";
import Image from "next/image";
import sendIcon from "../../../public/sendIcon.png";
import { MESSAGE_MAX_LENGTH } from "../../utils/textLimits";
import useIsMobile from "../../utils/useIsMobile";

interface SendBarProps {
  /**
   * Resolves once the message is stored and rejects if it is not, so this bar
   * can keep the text on failure.
   */
  onSendMessage: (content: string) => Promise<void>;
}

const SendBar = ({ onSendMessage }: SendBarProps) => {
  const [messageContent, setMessageContent] = useState("");
  const [isSending, setIsSending] = useState(false);
  const messageInputRef = useRef<HTMLDivElement>(null);
  // Behaviour, not styling, which is why this is the hook and not a
  // `desktop:` utility - the same split the inset docblock below draws.
  const isMobile = useIsMobile();

  // Measured on the raw text rather than the trimmed text so the counter and
  // the block agree with each other. `message.content` is `VARCHAR(255)`,
  // so this box needs a cap: without one, anything longer would be accepted
  // here, accepted by the server, and then rejected by MySQL.
  const isTooLong = messageContent.length > MESSAGE_MAX_LENGTH;

  const handleSend = async () => {
    const content = messageContent.trim();
    if (!content || isTooLong || isSending) {
      return;
    }

    setIsSending(true);
    try {
      await onSendMessage(content);
      setMessageContent("");
      if (messageInputRef.current) {
        messageInputRef.current.textContent = "";
      }
    } catch {
      // Deliberately left in the box. The mutation raises the error toast;
      // clearing unconditionally would take the user's text with a rejected
      // send and leave nothing to retry.
    } finally {
      setIsSending(false);
    }
  };

  /**
   * Enter sends on desktop only.
   *
   * The `!e.shiftKey` escape hatch is what makes a newline reachable, and a
   * phone keyboard has no Shift+Enter - so on mobile this handler alone
   * would be the whole story: Enter would send, unconditionally, and a
   * multi-line message would be impossible to type. Worse, the key that
   * does it is drawn by the operating system, so nothing on screen would
   * say it sends.
   *
   * Mobile therefore falls through to the browser's own default, which inserts
   * a newline. That the newline survives is a property of the box's
   * `white-space: pre-wrap` below: Chromium inserts a literal "\n" text node
   * rather than a wrapper element, so the `textContent` read in `onInput`
   * keeps it. Verified in Chromium rather than assumed - with the default
   * `white-space` it would be a `<div>` and `textContent` would silently
   * concatenate the lines.
   *
   * Sending on mobile is the Send button, which is beside the box and already
   * carries an accessible name.
   */
  const handleKeyPress = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    /*
      Both insets are responsive, and they are gated on different things:
      the horizontal one on the panel's width, the vertical one on the
      viewport's height.

      Nesting two unconditional insets - 24px of container padding and a
      further 40px of margin on the row inside it - would be 64px a side at
      every viewport. On a 375px phone that would leave the row 247px and
      the text itself about 170px, under half the screen, to compose a
      message that may run to 255 characters. The desktop inset is
      deliberate and stays at every width that needs it; only mobile avoids
      paying for it.

      **`message-panel-tall:` and not `desktop:` on the horizontal inset.**
      `desktop:` is a width alone, and a landscape phone is 667px wide - so
      it would get handed the 24px desktop inset, out of a panel that is the
      viewport less a 400px sidebar. The 8px a side that buys back is not a
      cosmetic gain: it widens the composer from 158px to 174, and
      `globals.css`'s `.placeholder:empty:before` hint measures 144.77px in
      this font, needing a 160.77px composer for one line - so at 158 it
      would wrap to two. Removing the wrap takes 13px off the bar, because
      the composer row is the send button's 46px plus 2px of border wherever
      the composer fits inside it. The row's own margins are gated on this
      same screen, for the same reason, and the two agree.

      The `sm` prefix is a trap here too: this repository overrides
      Tailwind's screens, so `sm` is 576px, and using it would leave every
      viewport from 576px to 639px on the desktop inset while `useIsMobile`
      still called it mobile. Both screens used here take their width term from
      the same constant the hook reads, so the CSS and the layout logic cannot
      disagree. And not the hook itself: `MessageHeader` and `MessagePanel`
      branch on structure - a different tree per platform - where this is one
      number, and a hook renders its server snapshot once during hydration, so
      the padding would visibly change after mount.

      **`message-panel-short:` on the vertical inset, and it is the first
      screen in this repository that narrows as a viewport grows.** 48px of
      a landscape phone's 375px viewport is vertical padding. It cannot move
      to the base the way every other value in this chrome does, because
      unlike the header this tree is shared with the mobile branch - so a
      smaller base would shrink the bar on a phone in portrait too, where the
      budget is not tight and where most of the traffic is.
      `MESSAGE_PANEL_SHORT_MEDIA_QUERY` carries the precedent, and why the
      boundary is a negated `min-height` rather than a `max-height`.

      **12px rather than a figure solved for**, and the reason is that it has to
      survive the next change to this chrome. The tab strip on the other side of
      the conversation is already `py-3`, so at 12px the two bars that frame it
      carry the same vertical inset - a relation that stays true when something
      else in the panel moves. Solving instead for a target content height would
      pin this number to every other term in the chrome at once, and the
      threshold's own docblock is a long account of how often those move. What
      it buys is measured rather than aimed at: 110px of bar becomes 73 and the
      conversation's content height goes from 83 to 120, with the newest message
      whole inside the port and 32px to spare where it had 3.
    */
    <div className="message-panel-tall:px-6 message-panel-short:py-3 border-t border-gray-200 px-4 py-6">
      {/*
        Flush with the container on mobile, so the row is inset 16px from the
        screen edge - the same 16px the message thread above it uses, which is
        what keeps the composer aligned with the bubbles it answers.

        **`message-panel-tall:` rather than `desktop:`, and the reason is a
        height even though the utility is a width.** This inset is 80px off a
        row that is only as wide as the panel, and the panel is the viewport
        less a 400px sidebar - so at 667px wide `desktop:` would leave the
        composer 78px. `globals.css`'s `.placeholder:empty:before` hint would
        then wrap to three lines and the bar would measure 131.5px instead
        of 97, which on a landscape phone is 131.5 of the 145px the
        conversation and the bar have to share. A flex item will not shrink
        below its min-content height, so the conversation would lose and the
        bar's last 18.38px would go off the bottom of the screen.

        Dropping the margin below the threshold returns the composer to
        158px and the bar to 110 - still two lines of hint, since the hint
        is 144.77px of text and wants a 160.77px composer; at 158 it is
        2.77px short of one line. So the container's own inset above - 8px
        a side rather than the desktop figure - is enough to clear it, and
        the wrap is gone rather than merely reduced.

        Nothing changes on either side of this band: a phone in portrait is
        below the width term and keeps `mx-0`, and a desktop window tall
        enough for the panel keeps the 80px it needs.
      */}
      <div className="message-panel-tall:mx-10 mx-0 flex items-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
        <div
          contentEditable="true"
          // The visible "Type a message..." hint is a CSS `:empty:before`
          // pseudo-element, which assistive tech is not required to announce, so
          // the name has to be stated explicitly.
          role="textbox"
          // True on both platforms: a newline is reachable on desktop
          // through Shift+Enter, and on mobile through the Enter handling
          // above falling through to the browser's own default.
          aria-multiline="true"
          aria-label="Message"
          // Labels the action key on a virtual keyboard, which is otherwise
          // drawn with no indication of what it does. "enter" because that is
          // now what it does - it inserts a newline. Labelling it "send" would
          // describe the Send button instead of this key. Inert where there is
          // no virtual keyboard, so it is set unconditionally rather than
          // through the hook, which keeps it out of the hydration snapshot.
          enterKeyHint="enter"
          // `text-lg` is kept at every width. It resolves to 1.125rem - 18px,
          // read from the compiled stylesheet rather than assumed - and
          // anything under 16px makes iOS Safari zoom the whole page when
          // the box takes focus, then leaves it zoomed. Shrinking the type
          // to fit more characters into a narrow box would trade legibility
          // for a width problem the inset above already solves.
          className="placeholder w-full flex-1 resize-none border-0 bg-gray-100 p-2 text-lg focus:outline-hidden"
          ref={messageInputRef}
          style={{
            minHeight: "20px",
            maxHeight: "100px",
            lineHeight: "normal",
            display: "inline-block",
            whiteSpace: "pre-wrap",
            overflowY: "auto",
            overflowWrap: "break-word",
          }}
          onInput={(e) => setMessageContent(e.currentTarget.textContent || "")}
          onKeyDown={handleKeyPress}
        ></div>
        <div className="h-10 w-px bg-gray-300" />
        <button
          type="button"
          onClick={handleSend}
          // Only ever disabled for `isTooLong` or `isSending`. An empty box
          // leaves the button live and the click a no-op.
          disabled={isTooLong || isSending}
          className={`p-2 px-4 pt-3 ${isTooLong || isSending ? "opacity-40" : ""}`}
          aria-label="Send message"
        >
          {/* Decorative: the button carries the name, so the image must not
              contribute a second one. */}
          <Image src={sendIcon} alt="" width={26} height={26} />
        </button>
      </div>
      {messageContent.length > 0 && (
        <div
          // The same inset as the row, at every viewport: this counts the
          // characters in that box, so it has to sit under its right edge
          // rather than under the container's. It therefore uses the same
          // screen the row above does - left on `desktop:` it would hang 40px
          // inboard of the box it belongs to on a landscape phone.
          className={`message-panel-tall:mx-10 mx-0 mt-1 text-end text-sm ${
            // text-stone-400 read at 2.52:1 against this panel's
            // white background, below the 4.5:1 body-text minimum. stone-600
            // clears it with margin; text-northeastern-red already did.
            isTooLong ? "text-northeastern-red" : "text-stone-600"
          }`}
        >
          {messageContent.length}/{MESSAGE_MAX_LENGTH}
        </div>
      )}
    </div>
  );
};

export default SendBar;
