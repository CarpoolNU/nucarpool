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
    <div className="border-t border-gray-200 p-6">
      <div className="mx-10 flex items-center overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
        <div
          contentEditable="true"
          // The visible "Type a message..." hint is a CSS `:empty:before`
          // pseudo-element, which assistive tech is not required to announce, so
          // the name has to be stated explicitly.
          role="textbox"
          aria-multiline="true"
          aria-label="Message"
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
          className={`mx-10 mt-1 text-end text-sm ${
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
