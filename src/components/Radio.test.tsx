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

/**
 * SCRUM-610 item 2: this radio's input is visually hidden but *focusable*, so
 * unlike `FormRadioButton`'s it was always reachable by keyboard - and gave no
 * sign of it. An input with no box of its own has nowhere for the browser's
 * default ring to be drawn, so a keyboard user tabbing through the profile
 * page's role selector could not see which of the three options they were on.
 *
 * Read off the stylesheet rather than off the template, so a rule that moves
 * between the two arms or loses its `:focus-visible` is visible here. The
 * matcher is a *prefix* match on `selectorText`, which is the difference from
 * `Header.test.tsx`'s `rulesFor`: an exact match finds only the unconditional
 * block and would drop the nested rule that is the entire subject.
 *
 * **What this cannot see is the ring.** jsdom computes no layout and paints
 * nothing, and it never puts an element into `:focus-visible` on its own - so
 * this proves the rule is emitted and targets the right selector, not that
 * two pixels of outline appear. That was checked in Chromium.
 */
describe.each(BRANCHES)("Radio focus indicator (%s)", (_branch, current) => {
  /**
   * Every declaration block whose selector *starts with* one of this element's
   * own generated class selectors, paired with that selector.
   */
  const rulesFor = (element: Element): string[] => {
    const prefixes = Array.from(element.classList).map((name) => `.${name}`);
    const collected: string[] = [];

    // Duck-typed on `conditionText` rather than `instanceof CSSMediaRule`,
    // for the reason `Header.test.tsx` records: those constructors are
    // jsdom's.
    const visit = (rule: CSSRule) => {
      const asMedia = rule as CSSMediaRule;
      if (typeof asMedia.conditionText === "string") {
        for (const inner of Array.from(asMedia.cssRules)) visit(inner);
        return;
      }

      const asStyle = rule as CSSStyleRule;
      const selector = asStyle.selectorText;
      if (
        typeof selector === "string" &&
        prefixes.some((prefix) => selector.startsWith(prefix))
      ) {
        collected.push(`${selector} { ${asStyle.style.cssText} }`);
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) visit(rule);
    }

    return collected;
  };

  const labelFor = (label: string) =>
    screen.getByRole("radio", { name: label }).closest("label")!;

  it("draws an outline on the label when the hidden input takes keyboard focus", () => {
    render(
      <Radio
        label="Driver"
        id="driver"
        value={Role.DRIVER}
        currentlySelected={current}
        onChange={() => undefined}
      />,
    );

    const rules = rulesFor(labelFor("Driver"));

    // The positive control, and a necessary one: `rulesFor` returning nothing
    // at all would satisfy a bare `find(...)` assertion by reading as "no
    // focus rule" when the truth is "no rules were collected". A declaration
    // this component has always carried proves the collection works.
    expect(rules.join(" ")).toContain("border-radius: 10px");

    const focusRule = rules.find((rule) =>
      rule.includes(":has(input:focus-visible)"),
    );
    expect(focusRule).toBeDefined();
    expect(focusRule).toContain("outline");

    // `:focus-visible`, not a bare `:focus`: a pointer click on this label
    // focuses the input too, and a ring on every click is noise.
    expect(rules.join(" ")).not.toContain(":has(input:focus)");
  });
});
