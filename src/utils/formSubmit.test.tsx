import type { KeyboardEvent } from "react";
import { preventEnterSubmitFromReadOnlyInput } from "./formSubmit";

/**
 * SCRUM-594. The handler cancels the *default action* of a keydown, so the two
 * ways to get it wrong are opposite: cancelling too little lets a picker's
 * Enter save the profile, and cancelling too much - any key, or any input -
 * takes Tab, arrows or typing away from a field. The component tests cover the
 * first; this covers the second, which they cannot see because they only press
 * Enter.
 */

const press = (key: string, target: EventTarget) => {
  const preventDefault = jest.fn();
  preventEnterSubmitFromReadOnlyInput({
    key,
    target,
    preventDefault,
  } as unknown as KeyboardEvent<HTMLFormElement>);
  return preventDefault;
};

const input = (readOnly: boolean) => {
  const element = document.createElement("input");
  element.readOnly = readOnly;
  return element;
};

describe("preventEnterSubmitFromReadOnlyInput", () => {
  it("cancels Enter in a read-only input", () => {
    expect(press("Enter", input(true))).toHaveBeenCalledTimes(1);
  });

  it.each(["Tab", "ArrowDown", "Escape", " ", "a"])(
    "leaves %s alone in a read-only input",
    (key) => {
      expect(press(key, input(true))).not.toHaveBeenCalled();
    },
  );

  it("leaves Enter alone in an editable input, which is the form's to submit", () => {
    expect(press("Enter", input(false))).not.toHaveBeenCalled();
  });

  it("leaves Enter alone on a target that is not an input", () => {
    // A picker's panel cells and a button both bubble a keydown up to the form.
    expect(
      press("Enter", document.createElement("button")),
    ).not.toHaveBeenCalled();
    expect(press("Enter", document.createElement("td"))).not.toHaveBeenCalled();
  });
});
