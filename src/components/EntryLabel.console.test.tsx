/**
 * That rendering `EntryLabel` with a validation error logs nothing (SCRUM-425).
 *
 * `StyledLabel` was `styled.label<{ error?: boolean }>`. styled-components v6
 * forwards any prop without a `$` prefix to the underlying element, so React
 * received `error={true}` on a `<label>`, declined to write it, and logged
 * ``Received `true` for a non-boolean attribute `error` ``. Prefixing it marks
 * the prop transient - consumed for the template, never forwarded.
 *
 * ---
 *
 * **Why this is a separate file from `EntryLabel.test.tsx`.** React caches this
 * warning per attribute name in a module-scoped object, so it fires once and is
 * then suppressed for the lifetime of the module. `Header.console.test.tsx`
 * records the measurement that established this (render 1 logs, renders 2 and 3
 * do not), and CLAUDE.md's conventions section now states the rule: a
 * `console.error` spy only observes the warning if nothing earlier in the same
 * module registry already triggered it.
 *
 * `EntryLabel.test.tsx` renders an errored label to assert its colour, which
 * would consume the one warning available in that registry - so a spy added
 * there would pass against the unfixed component. This file exists so the
 * assertion is first, and so nothing added later can quietly take the warning
 * it depends on.
 *
 * There is one wrinkle specific to this component, worth stating because it
 * makes the trap easier to fall into here than in `Header`: only a `true` value
 * warns, and `EntryLabel` renders `$error={!!props.error}`. So a test rendering
 * a label with *no* error does not consume the warning at all, and reordering
 * this file's sibling could appear to work by accident. Do not rely on that.
 *
 * **Keep this file to one rendering test**, for the same reason as
 * `Header.console.test.tsx`: a second would assert against a suppressed warning
 * and pass regardless.
 *
 * `EntryLabel` needs no mocks - it imports a type from `react-hook-form` and
 * `styled-components`, and reaches no router, query or session.
 */

import { render, screen } from "@testing-library/react";
import type { FieldError } from "react-hook-form";
import { EntryLabel } from "./EntryLabel";

/** What `react-hook-form` hands the component when a field fails validation. */
const FIELD_ERROR: FieldError = {
  type: "required",
  message: "Please enter a preferred name.",
};

it("renders an errored label without logging a React warning", () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation();

  try {
    render(<EntryLabel required label="Preferred Name" error={FIELD_ERROR} />);

    /*
     * `required` is what puts the component down the branch that passes
     * `$error` at all - the non-required branch renders `<StyledLabel>` with no
     * error prop whatsoever. Asserting the label is present keeps this test
     * honest about having rendered that branch rather than an early return.
     */
    expect(screen.getByText(/Preferred Name/)).toBeInTheDocument();

    const logged = consoleError.mock.calls.map((call) => JSON.stringify(call));

    expect(
      logged.filter((call) => call.includes("non-boolean attribute")),
    ).toEqual([]);

    // Nothing else either. This component renders on the profile page and all
    // four setup steps, so a clean console here is worth more than a clean one
    // for this single attribute.
    expect(logged).toEqual([]);
  } finally {
    consoleError.mockRestore();
  }
});
