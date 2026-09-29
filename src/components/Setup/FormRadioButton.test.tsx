/**
 * SCRUM-593: `FormRadioButton` rendered its error as a bare `<p>` inside the
 * `<label>` with no `id` and no `aria-describedby` on the input - one of the
 * "same treatment" call sites named alongside `TextField` in the ticket's
 * evidence. This is the ticket's required non-`TextField` unit: an error
 * forced on a component that isn't `TextField`, asserted with
 * `toHaveAccessibleDescription` rather than an attribute check, for the same
 * dangling-reference reason `TextField.test.tsx` gives.
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
