import { fireEvent, render, screen } from "@testing-library/react";
import SendBar from "./SendBar";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * What this suite can and cannot say about the composer's Enter key.
 *
 * The defect was that Enter sent the message at every viewport. On a desktop
 * that is the convention and Shift+Enter still reaches a newline; on a phone
 * keyboard there is no Shift+Enter, so Enter sending was the only thing Enter
 * could do and a multi-line message was impossible to type. The key itself is
 * drawn by the operating system, so nothing on screen warned that it would
 * send.
 *
 * **`enterKeyHint` is asserted as an attribute and nothing more.** Whether a
 * virtual keyboard actually relabels its action key is a property of iOS and
 * Android, not of the DOM, and jsdom has no keyboard at all - so the honest
 * assertion is that the hint reaches the element. That it reads the way the
 * platform draws it needs a real device.
 *
 * The viewport is set **before** `render` on purpose. `useIsMobile` is a
 * `useSyncExternalStore` hook, so a fresh client mount reads `getSnapshot`
 * once - a width written afterwards would need a `resize` event to be noticed.
 * See `testing/viewport.ts` for what else jsdom will not do here.
 */

/** The width has to be restored between tests; it persists within a file. */
restoreViewportAfterEach();

/**
 * Put text in the box the way the component learns about it.
 *
 * `SendBar` is a `contentEditable` div, not an input, so there is no value to
 * set - it tracks its own state from the `onInput` handler reading
 * `textContent`. Writing `textContent` and firing `input` is therefore the
 * only way to reach a non-empty `messageContent`, and without it `handleSend`
 * returns early on the empty guard and every assertion below would pass
 * regardless of the Enter handling.
 */
const typeMessage = (text: string) => {
  const box = screen.getByRole("textbox", { name: "Message" });
  box.textContent = text;
  fireEvent.input(box);

  return box;
};

describe("SendBar", () => {
  it("labels the virtual keyboard's action key", () => {
    render(<SendBar onSendMessage={jest.fn()} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "enterkeyhint",
      "enter",
    );
  });

  it("does not send on Enter at a mobile viewport", async () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    setViewportWidth(MOBILE_WIDTH);
    render(<SendBar onSendMessage={onSendMessage} />);

    const box = typeMessage("first line");
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("still sends on Enter at a desktop viewport", () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    setViewportWidth(DESKTOP_WIDTH);
    render(<SendBar onSendMessage={onSendMessage} />);

    const box = typeMessage("hello");
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSendMessage).toHaveBeenCalledWith("hello");
  });

  /**
   * The escape hatch that made `aria-multiline` true on desktop, kept as a
   * regression guard: the fix narrowed the Enter branch, and narrowing it the
   * wrong way would have been to drop the `shiftKey` test instead of adding
   * the viewport one.
   */
  it("does not send on Shift+Enter at a desktop viewport", () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    setViewportWidth(DESKTOP_WIDTH);
    render(<SendBar onSendMessage={onSendMessage} />);

    const box = typeMessage("hello");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  /**
   * The button is the only way to send on a phone once Enter inserts a
   * newline, so it is part of this fix rather than incidental coverage.
   */
  it("sends from the button at a mobile viewport", () => {
    const onSendMessage = jest.fn().mockResolvedValue(undefined);
    setViewportWidth(MOBILE_WIDTH);
    render(<SendBar onSendMessage={onSendMessage} />);

    typeMessage("sent by button");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("sent by button");
  });
});
