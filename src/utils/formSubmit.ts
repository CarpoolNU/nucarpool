import type { KeyboardEvent } from "react";

/**
 * A form `onKeyDown` that stops Enter in a **read-only input** from submitting
 * the form (SCRUM-594).
 *
 * The onboarding wizard and the profile tabs are real forms now, so Enter in a
 * field is implicit submission. That is right for a text box and wrong for the
 * antd month and time pickers, whose inputs are `inputReadOnly` and use Enter
 * for their own job: on a closed picker it opens the panel, and on an open one
 * it confirms the highlighted value. Neither path cancels the event, so
 * without this the browser also submits - opening End Date would save the
 * whole profile, or advance the wizard a step, as a side effect.
 *
 * **It has to sit on the form, not the picker.** `rc-picker` runs the
 * consumer's `onKeyDown` first and skips its own Enter handling when the event
 * is already `defaultPrevented`, so cancelling at the picker would stop the
 * panel from opening at all. On the form the handler runs after the picker's,
 * as the event bubbles, and only cancels what is left - the browser's
 * implicit submission, which is the keydown's default action.
 *
 * "Read-only input" rather than "inside `.ant-picker`", so the rule does not
 * depend on antd's generated class names. A read-only field has nothing to
 * commit by pressing Enter, so it is a fair rule on its own terms; it happens
 * that every picker here sets `inputReadOnly`, and none of the other inputs in
 * these forms are read-only.
 */
export const preventEnterSubmitFromReadOnlyInput = (
  event: KeyboardEvent<HTMLFormElement>,
): void => {
  if (event.key !== "Enter") {
    return;
  }
  const { target } = event;
  if (target instanceof HTMLInputElement && target.readOnly) {
    event.preventDefault();
  }
};
