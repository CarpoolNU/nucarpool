/**
 * `EntryLabel`'s one piece of conditional styling.
 *
 * The `$error` prop's entire effect is the label's colour, and these are the
 * assertions that catch a half-done rename: prefixing the declaration and the
 * call site but leaving the template reading `props.error` makes the
 * interpolation `undefined`, so nothing is forwarded - no React warning fires,
 * `EntryLabel.console.test.tsx` passes, and the error colour silently
 * disappears. `tsc` also rejects that particular mutation, but these hold
 * independently of what the prop is named.
 *
 * **On `getComputedStyle`, which `src/testing/viewport.ts` calls a trap.** That
 * caveat is about *inline* styles, where it echoes the declared string back
 * uncomputed and looks like a measurement without being one. These values come
 * from the stylesheet styled-components injects, and jsdom does resolve that
 * cascade - it parsed `#B12424` into `rgb(177, 36, 36)`. Real parsing, not an
 * echo. It is still not layout: this says the rule applies to the element, not
 * that anything is painted.
 *
 * This file deliberately does **not** spy on `console.error`. Rendering an
 * errored label here consumes the one non-boolean-attribute warning React makes
 * available per module registry, so an assertion about it belongs in its own
 * file - see `EntryLabel.console.test.tsx`, and CLAUDE.md's conventions
 * section.
 */

import { render, screen } from "@testing-library/react";
import type { FieldError } from "react-hook-form";
import { EntryLabel } from "./EntryLabel";

const FIELD_ERROR: FieldError = {
  type: "required",
  message: "Please enter a preferred name.",
};

/** The label element itself, which is what carries the generated class. */
const labelFor = (text: RegExp) => screen.getByText(text);

describe("EntryLabel's error colour", () => {
  it("renders a failed required field in the error red", () => {
    render(<EntryLabel required label="Preferred Name" error={FIELD_ERROR} />);

    // #B12424, the value in the component's template.
    expect(getComputedStyle(labelFor(/Preferred Name/)).color).toBe(
      "rgb(177, 36, 36)",
    );
  });

  it("renders a required field with no error in the default black", () => {
    render(<EntryLabel required label="Pronouns" />);

    /*
     * The other side, so a component hard-coded to the error colour fails.
     * This is the `$error={false}` path rather than the no-prop path: the
     * required branch always passes the prop, and passes `!!props.error`.
     */
    expect(getComputedStyle(labelFor(/Pronouns/)).color).toBe("rgb(0, 0, 0)");
  });

  it("marks a required field with an asterisk, and an optional one without", () => {
    const { unmount } = render(<EntryLabel required label="Start Date" />);

    // The asterisk is a sibling span, so the label's own text is matched
    // loosely above and the marker asserted separately.
    expect(screen.getByText("*")).toBeInTheDocument();

    unmount();
    render(<EntryLabel label="Notes" />);

    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });
});
