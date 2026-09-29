/**
 * SCRUM-593: `TextField` rendered its error message as a sibling `<span>`
 * with no `id`, no `role` and no `aria-invalid`/`aria-describedby` on the
 * input - so a screen-reader user who reached a failed field heard its name
 * and value and nothing else. The fix computes one id from the field's own
 * id/name, points the input's `aria-describedby` at it, and gives the
 * rendered message that id plus `role="alert"` so it is both resolvable and
 * announced.
 *
 * `toHaveAccessibleDescription` is used throughout, not
 * `toHaveAttribute("aria-describedby", ...)`, because an attribute pointing
 * at a missing id passes the attribute check and still fails the user - the
 * dangling-reference case the ticket calls out as the likeliest way to get
 * this wrong.
 */
import { render, screen } from "@testing-library/react";
import type { FieldError } from "react-hook-form";
import { TextField } from "./TextField";

const FIELD_ERROR: FieldError = {
  type: "required",
  message: "Please enter a workplace name.",
};

describe("TextField error association", () => {
  it("gives an errored input an accessible description matching the visible message", () => {
    render(
      <TextField id="companyName" name="companyName" error={FIELD_ERROR} />,
    );

    const input = screen.getByRole("textbox");
    expect(input).toHaveAccessibleDescription("Please enter a workplace name.");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("resolves the description to the actual rendered error element", () => {
    render(
      <TextField id="companyName" name="companyName" error={FIELD_ERROR} />,
    );

    const input = screen.getByRole("textbox");
    const describedbyId = input.getAttribute("aria-describedby");
    expect(describedbyId).toBeTruthy();

    const errorNode = document.getElementById(describedbyId!);
    expect(errorNode).not.toBeNull();
    expect(errorNode).toHaveTextContent("Please enter a workplace name.");
    expect(errorNode).toHaveAttribute("role", "alert");
  });

  it("carries no invalid state or dangling description when there is no error", () => {
    render(<TextField id="companyName" name="companyName" />);

    const input = screen.getByRole("textbox");

    // Absent, not "false" - either satisfies the requirement, and this is the
    // branch the component actually takes.
    expect(input).not.toHaveAttribute("aria-invalid");

    // The stronger of the two assertions: not just "no attribute", but no
    // description at all, so a leftover `aria-describedby` pointing at
    // nothing cannot slip through the first check unnoticed.
    expect(input).toHaveAccessibleDescription("");
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("falls back to name when no id is given, so the two still agree", () => {
    render(<TextField name="companyName" error={FIELD_ERROR} />);

    const input = screen.getByRole("textbox");
    expect(input).toHaveAccessibleDescription("Please enter a workplace name.");
  });
});
