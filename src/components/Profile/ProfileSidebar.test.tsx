import { render, screen } from "@testing-library/react";
import ProfileSidebar from "./ProfileSidebar";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * The classes the profile sidebar actually puts on its buttons.
 *
 * **This is one of the few styling assertions worth making in this suite**, and
 * it is worth being precise about why. jsdom does no layout and computes no
 * media queries, so it can never tell you that a button *looks* bigger at
 * 1440px — see `testing/viewport.ts`. What it can tell you is which tokens
 * React wrote into the `class` attribute, and that is exactly where this defect
 * lived: the desktop branch built each button's className as
 * `baseButton + (option === "user" && selectedButton)`, string concatenation
 * with no separator and a boolean as the right operand.
 *
 * Both outcomes were coerced into the string and destroyed the class that
 * happened to sit last in `baseButton`:
 *
 *   unselected -> `… text-xl lg:text-2xlfalse`
 *   selected   -> `… text-xl lg:text-2xlfont-bold !text-northeastern-red`
 *
 * So `lg:text-2xl` never applied to any of the three buttons, and the selected
 * one was red but never bold - only `!text-northeastern-red` survived, because
 * it happens to follow a space inside `selectedButton`.
 *
 * Neither corrupted token is in the compiled stylesheet, which is the part
 * worth remembering: Tailwind scans *source text*, and these strings only ever
 * existed at runtime. So the browser matched no rule at all, and no amount of
 * looking at the CSS output would have shown it. The `class` attribute is the
 * only place the bug is visible.
 *
 * Asserted as **discrete tokens**, never as substrings of the whole string:
 * `className.includes("lg:text-2xl")` is true of `lg:text-2xlfalse`, so the
 * substring form passes against the bug it is meant to catch.
 *
 * Buttons are found by their **exact** accessible name. They were once found
 * by a regular expression over the label instead, because each icon inside them
 * contributed its `alt` text to that name - "user User Profile", "car Carpool
 * Details". That was a second defect, fixed under SCRUM-446, and the matchers
 * tightened along with it: the regex form is precisely what could not see it,
 * since /User Profile/ matches "user User Profile" as happily as it matches the
 * right answer.
 */

restoreViewportAfterEach();

/** The class attribute as the browser reads it: a list of tokens. */
const tokensOf = (element: HTMLElement): string[] =>
  (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/**
 * Every image's `alt` exactly as the accessible-name computation reads it.
 *
 * The attribute rather than the property, so that a *missing* `alt` comes back
 * as `null` and is distinguishable from an empty one. The two are not
 * equivalent: an empty `alt` marks the image presentational, while no `alt` at
 * all leaves assistive technology to guess, often from the file name - which is
 * the same failure in a less obvious form.
 */
const imageAltsOf = (container: HTMLElement): (string | null)[] =>
  [...container.querySelectorAll("img")].map((image) =>
    image.getAttribute("alt"),
  );

const renderSidebar = (option: "user" | "carpool" | "account" = "user") =>
  render(<ProfileSidebar option={option} setOption={jest.fn()} />);

/** Desktop labels. The mobile branch uses shorter ones. */
const DESKTOP_BUTTONS = ["User Profile", "Carpool Details", "Account Status"];

/** The mobile branch's own three, in the order it renders them. */
const MOBILE_BUTTONS = ["Profile", "Carpool", "Account"];

describe("the desktop sidebar", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("gives every button the lg type scale", () => {
    // All three, because the three call sites are identical in shape: fixing
    // one would leave a file where two of the buttons are still wrong.
    renderSidebar();

    for (const name of DESKTOP_BUTTONS) {
      expect(tokensOf(screen.getByRole("button", { name }))).toContain(
        "lg:text-2xl",
      );
    }
  });

  it("renders the selected button bold as well as red", () => {
    renderSidebar("carpool");

    const tokens = tokensOf(
      screen.getByRole("button", { name: "Carpool Details" }),
    );

    expect(tokens).toContain("font-bold");
    // The class that survived the concatenation, so this half never failed.
    // Asserted anyway: it is what made the defect look deliberate, and a fix
    // that swapped one for the other would be no fix.
    expect(tokens).toContain("!text-northeastern-red");
  });

  it("keeps the unselected buttons unbold", () => {
    // The other half of "the selection is distinguishable". Without this, a
    // fix that put `selectedButton` on every button would pass the test above.
    renderSidebar("carpool");

    for (const name of ["User Profile", "Account Status"]) {
      expect(tokensOf(screen.getByRole("button", { name }))).not.toContain(
        "font-bold",
      );
    }
  });

  /*
   * SCRUM-446. Each button held an icon rendered with descriptive alt text -
   * `alt="user"`, `alt="car"`, `alt="checkbox"` - and an image's alt text
   * contributes to the accessible name of the control containing it, so the
   * buttons announced themselves as "user User Profile", "car Carpool Details"
   * and "checkbox Account Status". The last is the worst of the three:
   * `checkbox` names a widget role these controls do not have.
   *
   * The two assertions are deliberately separate. The first pins the names
   * these three buttons must have; the second is the property behind it, and
   * covers an icon added later that this file does not yet know about.
   */

  it("names every button with its visible label and nothing else", () => {
    renderSidebar();

    for (const name of DESKTOP_BUTTONS) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("lets no icon contribute to a name", () => {
    const { container } = renderSidebar();

    expect(imageAltsOf(container)).toEqual(["", "", ""]);
  });

  it("writes no token that a boolean was concatenated into", () => {
    // The defect's signature, stated as a property rather than as the two
    // specific strings: a `&&` whose left side is false stringifies to
    // "false", and any token carrying it matches no rule in the stylesheet.
    //
    // Swept across the whole rendered tree rather than the buttons alone,
    // because the same mistake appears on the icon wrappers inside them -
    // there inside a template literal, so it costs a stray `false` class
    // rather than a corrupted one.
    const { container } = renderSidebar("account");

    const offenders = [...container.querySelectorAll("[class]")]
      .flatMap((element) => tokensOf(element as HTMLElement))
      .filter((token) => token.includes("false") || token.includes("true"));

    expect(offenders).toEqual([]);
  });

  it("leaves no class glued to the one after it", () => {
    // Narrower and more direct: whatever else changes, nothing may sit
    // immediately after `text-2xl` inside a single token. This is the shape
    // that made the bug invisible - the buttons still looked sized, because
    // `text-xl` was intact.
    const { container } = renderSidebar("user");

    const glued = [...container.querySelectorAll("[class]")]
      .flatMap((element) => tokensOf(element as HTMLElement))
      .filter((token) => /text-2xl./.test(token));

    expect(glued).toEqual([]);
  });
});

describe("the mobile sidebar", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  /*
   * This branch was already correct - a template literal with explicit spaces
   * and a ternary - and the ticket's requirement is that it stay untouched. It
   * is asserted rather than trusted because the fix makes the desktop branch
   * look like this one, and the easy mistake is to "unify" them into something
   * that serves neither.
   */

  it("builds its own classes cleanly", () => {
    renderSidebar("user");

    const tokens = tokensOf(screen.getByRole("button", { name: "Profile" }));

    // Its own type scale, not the desktop one.
    expect(tokens).toContain("text-base");
    expect(tokens).not.toContain("lg:text-2xl");
    expect(tokens).toContain("font-bold");
    // The mobile-only selection affordance.
    expect(tokens).toContain("border-b-4");
  });

  it("names every button with its visible label and nothing else", () => {
    // The shorter labels, and the same requirement. Both branches render their
    // own three icons, so fixing one would leave the other announcing them.
    renderSidebar();

    for (const name of MOBILE_BUTTONS) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("lets no icon contribute to a name either", () => {
    const { container } = renderSidebar();

    expect(imageAltsOf(container)).toEqual(["", "", ""]);
  });

  it("writes no stringified boolean either", () => {
    const { container } = renderSidebar("carpool");

    const offenders = [...container.querySelectorAll("[class]")]
      .flatMap((element) => tokensOf(element as HTMLElement))
      .filter((token) => token.includes("false") || token.includes("true"));

    expect(offenders).toEqual([]);
  });
});
