import React, { useRef, useState } from "react";
import Image from "next/image";
import sendIcon from "../../../public/sendIcon.png";
import { MESSAGE_MAX_LENGTH } from "../../utils/textLimits";

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

  // Measured on the raw text rather than the trimmed text so the counter and
  // the block agree with each other. `message.content` is `VARCHAR(255)` and
  // this box used to have no cap at all, so anything longer was accepted here,
  // accepted by the server, and then rejected by MySQL.
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
      // Deliberately left in the box. The mutation raises the error toast; the
      // old code cleared unconditionally, so a rejected send took the user's
      // text with it and there was nothing to retry.
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    /*
      The horizontal inset is responsive; the vertical one deliberately is
      not.

      This bar used to nest two unconditional insets - 24px of container
      padding and a further 40px of margin on the row inside it - which is
      64px a side at every viewport. On a 375px phone that left the row 247px
      and the text itself about 170px, under half the screen, to compose a
      message that may run to 255 characters. The desktop inset is
      deliberate and is unchanged; mobile was simply paying for it.

      **`desktop:` rather than the `ismobile` hook or a `sm` prefix**, and
      both alternatives are worse here for concrete reasons. The hook is what
      `MessageHeader` and `MessagePanel` use, but they branch on structure -
      a different tree per platform - and this is one number; a hook also
      renders its server snapshot once during hydration, so the padding would
      visibly change after mount. The `sm` prefix is the trap: this repository
      overrides Tailwind's screens, so `sm` is 576px, and using it would leave
      every viewport from 576px to 639px on the desktop inset while
      `useIsMobile` still called it mobile. `desktop:` is 640px *from the same
      definition the hook reads*, so the CSS and the layout logic cannot
      disagree. This is its first use in markup; the screen was registered for
      exactly this.

      Vertical padding stays at 24px on both platforms. The vertical budget on
      a phone is tight - the header gained a request-controls row - but that is
      a different question, and answering both at once would leave a reviewer
      unable to judge either.
    */
    <div className="desktop:px-6 border-t border-gray-200 px-4 py-6">
      {/*
        Flush with the container on mobile, so the row is inset 16px from the
        screen edge - the same 16px the message thread above it uses, which is
        what keeps the composer aligned with the bubbles it answers.
      */}
      <div className="desktop:mx-10 mx-0 flex items-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
        <div
          contentEditable="true"
          // The visible "Type a message..." hint is a CSS `:empty:before`
          // pseudo-element, which assistive tech is not required to announce, so
          // the name has to be stated explicitly.
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
          // `text-lg` is kept at every width, which was the other half of the
          // decision the inset raised. It resolves to 1.125rem - 18px, read
          // from the compiled stylesheet rather than assumed - and anything
          // under 16px makes iOS Safari zoom the whole page when the box takes
          // focus, then leaves it zoomed. The box being too narrow was the
          // defect; shrinking the type to fit more characters into a narrow box
          // trades legibility for a problem that is now fixed.
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
          // Only ever disabled for the two states that are new here. An empty
          // box leaves the button live and the click a no-op, exactly as before.
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
          // The same inset as the row, at both widths: this counts the
          // characters in that box, so it has to sit under its right edge
          // rather than under the container's.
          className={`desktop:mx-10 mx-0 mt-1 text-end text-sm ${
            isTooLong ? "text-northeastern-red" : "text-stone-400"
          }`}
        >
          {messageContent.length}/{MESSAGE_MAX_LENGTH}
        </div>
      )}
    </div>
  );
};

export default SendBar;
