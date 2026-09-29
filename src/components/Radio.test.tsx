/**
 * SCRUM-596: `Radio` - the role selector on the profile page - rendered its
 * error as a bare `<p>` inside the `<label>` with no `id`, no `role="alert"`
 * and no `aria-describedby` on the input, the defect SCRUM-593 fixed on
 * `FormRadioButton`. It also had that component's second defect: the `<p>`
 * sits inside the wrapping label, so "name from content" folded the error
 * text into the radio's accessible *name*.
 *
 * Asserted with `toHaveAccessibleDescription` rather than an attribute
 * check, for the dangling-reference reason `TextField.test.tsx` gives.
 * `Radio` renders two branches (selected and not), each with its own copy of
 * the error, so both are covered.
 *
 * `aria-invalid` is deliberately absent: the ARIA spec doesn't support it on
 * `role="radio"`, which `yarn lint`'s `jsx-a11y/role-supports-aria-props`
 * catches. `aria-describedby` is a global property and carries the message.
 */
import { Role } from "@prisma/client";
import { render, screen } from "@testing-library/react";
import type { FieldError } from "react-hook-form";
import Radio from "./Radio";

const ROLE_ERROR: FieldError = {
  type: "required",
  message: "Please select a role.",
};

const BRANCHES: ReadonlyArray<[string, Role]> = [
  ["selected", Role.DRIVER],
  ["unselected", Role.RIDER],
];

describe.each(BRANCHES)("Radio error association (%s)", (_branch, current) => {
  const renderRadio = (error?: FieldError) =>
    render(
      <Radio
        label="Driver"
        id="driver"
        value={Role.DRIVER}
        currentlySelected={current}
        error={error}
        onChange={() => undefined}
      />,
    );

  it("gives an errored radio an accessible description matching the visible message", () => {
    renderRadio(ROLE_ERROR);

    const radio = screen.getByRole("radio", { name: "Driver" });
    expect(radio).toHaveAccessibleDescription("Please select a role.");
    // Not `aria-invalid`: see the file header.
    expect(radio).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the accessible name to the label text once an error renders", () => {
    renderRadio(ROLE_ERROR);

    // An exact-string `name` fails if the error text is folded in.
    expect(screen.getByRole("radio", { name: "Driver" })).toBeInTheDocument();
  });

  it("resolves the description to the actual rendered error element", () => {
    renderRadio(ROLE_ERROR);

    const radio = screen.getByRole("radio", { name: "Driver" });
    const describedbyId = radio.getAttribute("aria-describedby");
    expect(describedbyId).toBeTruthy();

    const errorNode = document.getElementById(describedbyId!);
    expect(errorNode).not.toBeNull();
    expect(errorNode).toHaveTextContent("Please select a role.");
    expect(errorNode).toHaveAttribute("role", "alert");
  });

  it("carries no dangling description when there is no error", () => {
    renderRadio();

    const radio = screen.getByRole("radio", { name: "Driver" });
    expect(radio).toHaveAccessibleDescription("");
    expect(radio.getAttribute("aria-describedby")).toBeNull();
  });
});
