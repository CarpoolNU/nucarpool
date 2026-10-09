/**
 * `FormRadioButton`'s error has an `id` and is referenced by the input's
 * `aria-describedby`; a bare `<p>` inside the `<label>` reaches no assistive
 * technology. This is the non-`TextField` case: an error forced on a component
 * that isn't `TextField`, asserted with `toHaveAccessibleDescription` rather
 * than an attribute check, for the same dangling-reference reason
 * `TextField.test.tsx` gives.
 *
 * `aria-invalid` is deliberately absent from the radio itself - the ARIA spec
 * doesn't support it on `role="radio"`, which `yarn lint`'s
 * `jsx-a11y/role-supports-aria-props` catches. The description is still
 * carried by `aria-describedby`, which is a global property.
 */
import { render, screen } from "@testing-library/react";
import type { FieldError } from "react-hook-form";
import RadioButton from "./FormRadioButton";

const ROLE_ERROR: FieldError = {
  type: "required",
  message: "Please select a role.",
};

describe("FormRadioButton error association", () => {
  it("gives an errored radio an accessible description matching the visible message", () => {
    render(
      <RadioButton
        label="Driver"
        id="driver"
        value="DRIVER"
        currentlySelected="RIDER"
        error={ROLE_ERROR}
      />,
    );

    const radio = screen.getByRole("radio", { name: "Driver" });
    expect(radio).toHaveAccessibleDescription("Please select a role.");
    // Not `aria-invalid`: see the file header.
    expect(radio).not.toHaveAttribute("aria-invalid");
  });

  it("resolves the description to the actual rendered error element", () => {
    render(
      <RadioButton
        label="Driver"
        id="driver"
        value="DRIVER"
        currentlySelected="RIDER"
        error={ROLE_ERROR}
      />,
    );

    const radio = screen.getByRole("radio", { name: "Driver" });
    const describedbyId = radio.getAttribute("aria-describedby");
    expect(describedbyId).toBeTruthy();

    const errorNode = document.getElementById(describedbyId!);
    expect(errorNode).not.toBeNull();
    expect(errorNode).toHaveTextContent("Please select a role.");
    expect(errorNode).toHaveAttribute("role", "alert");
  });

  it("carries no dangling description when there is no error", () => {
    render(
      <RadioButton
        label="Driver"
        id="driver"
        value="DRIVER"
        currentlySelected="RIDER"
      />,
    );

    const radio = screen.getByRole("radio", { name: "Driver" });
    expect(radio).toHaveAccessibleDescription("");
    expect(radio.getAttribute("aria-describedby")).toBeNull();
  });
});

/**
 * The radio input must not carry a class compiling to `display: none`.
 *
 * That is the one way of hiding a form control which removes it from the tab
 * order *and* from the accessibility tree at once, so the `aria-label` the
 * component is careful to set reaches nothing, and step 1 of
 * `/profile/setup` - choosing Viewer, Rider or Driver, the first thing every
 * new user does - cannot be completed without a pointer at all.
 *
 * **Every test above passes either way, and that is this block's reason for
 * existing.** jsdom loads no stylesheet, so a Tailwind class name is an inert
 * string here and `getByRole("radio")` finds these controls perfectly well
 * even where a real browser hides them. No jsdom assertion can see the
 * hiding itself; what is assertable is the class contract behind it, which is
 * what the two cases below pin. That Tab reaches each radio and an arrow key
 * moves between them was verified in Chromium against the compiled stylesheet
 * - jsdom cannot answer it, and a green run here does not claim to.
 */
describe("FormRadioButton keyboard reachability", () => {
  const renderRadio = () =>
    render(
      <RadioButton
        label="Driver"
        id="driver"
        value="DRIVER"
        currentlySelected="RIDER"
      />,
    );

  it("hides the input visually rather than removing it from the page", () => {
    renderRadio();
    const radio = screen.getByRole("radio", { name: "Driver" });

    const classes = radio.className.split(" ");
    // The clipped-1px-box pattern, which stays focusable and announced.
    expect(classes).toContain("sr-only");
    // And specifically not the `display: none` one it replaced.
    expect(classes).not.toContain("hidden");
  });

  it("puts the focus ring on the label, the only box the user can see", () => {
    renderRadio();
    const label = screen
      .getByRole("radio", { name: "Driver" })
      .closest("label");

    // The control: the ring has to land on the wrapping label, so prove the
    // label is found before asserting anything about its classes.
    expect(label).not.toBeNull();

    // Keyed off the hidden input's own focus state, and on `:focus-visible`
    // rather than `:focus` so that a pointer click paints nothing.
    expect(label!.className).toContain("has-[:focus-visible]:outline");
    expect(label!.className).toContain("has-[:focus-visible]:outline-2");
  });
});
