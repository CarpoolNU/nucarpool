import { render, screen } from "@testing-library/react";
import AdminSidebar from "./AdminSidebar";

/**
 * The classes the admin sidebar puts on its two buttons.
 *
 * This is the sibling of `ProfileSidebar.test.tsx`, and the defect it covers
 * (SCRUM-450) is the same *shape* as the one that file describes at length: a
 * `&&` expression concatenated into a `className`, whose false branch
 * stringifies to `"false"` and ships as a class token.
 *
 * It was the milder of the two, and the difference is worth recording, because
 * it is the whole reason this component looked fine. Here `baseButton` ended
 * in a space and `selectedButton` began with one, so every real utility stayed
 * separated and did apply - only a meaningless `false` was appended. In
 * `ProfileSidebar` the separators were missing, so `lg:text-2xl` was glued to
 * its neighbour and silently stopped working. Same construct, one visual bug
 * and one invisible one.
 *
 * So these tests are not defending an appearance; they are defending the
 * *construct*. The fix replaces the concatenation with a template literal
 * carrying explicit separators, which is what SCRUM-438 settled on, and which
 * removes the invisible load-bearing spaces that made the sibling defect
 * possible in the first place.
 *
 * jsdom does no layout, so it can never tell you these buttons *look* right -
 * see `testing/viewport.ts`. What it can tell you is which tokens React wrote
 * into the `class` attribute, and that is exactly where this defect lives.
 * `AdminSidebar` takes two props and has no router, tRPC client or portal, so
 * it renders standalone; the desktop sidebar is its only appearance, since
 * `/admin` below 640px renders `AdminMobileNotice` instead (SCRUM-434).
 *
 * Asserted as **discrete tokens**, never as substrings of the whole class
 * string, for the reason the sibling file gives: `includes("text-xl")` is true
 * of a corrupted `text-xlfalse`, so the substring form passes against the very
 * bug it is meant to catch.
 */

/** The class attribute as the browser reads it: a list of tokens. */
const tokensOf = (element: HTMLElement): string[] =>
  (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const renderSidebar = (option = "management") =>
  render(<AdminSidebar option={option} setOption={jest.fn()} />);

/** Both buttons, by the exact accessible name each must have. */
const BUTTONS = ["Management", "Data"];

/** The three classes that mark the selected button, and only it. */
const SELECTED_CLASSES = ["font-bold", "underline", "underline-offset-8"];

/** Every class token in the rendered tree that carries a stringified boolean. */
const stringifiedBooleansIn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("[class]")]
    .flatMap((element) => tokensOf(element as HTMLElement))
    .filter((token) => token.includes("false") || token.includes("true"));

it("writes no token that a boolean was concatenated into", () => {
  // The defect's signature, stated as a property rather than as the one
  // specific string: a `&&` whose left side is false stringifies to "false",
  // and any token carrying it matches no rule in the stylesheet.
  //
  // Rendered with "management" selected, so the Data button is the unselected
  // one that carries the stray token. Swept across the whole tree rather than
  // the buttons alone, so the same mistake added to a wrapper later is caught
  // by this test rather than by a new one.
  const { container } = renderSidebar("management");

  expect(stringifiedBooleansIn(container)).toEqual([]);
});

it("writes no stringified boolean with the other button selected either", () => {
  // The two call sites are identical in construction, so fixing one would
  // leave a file where the other still appends `false`. This is the half that
  // catches that.
  const { container } = renderSidebar("data");

  expect(stringifiedBooleansIn(container)).toEqual([]);
});

it("leaves no class glued to the one after it", () => {
  // The sibling defect, asserted here before it can happen. The separators
  // that keep this component's utilities apart currently live *inside* the two
  // constants as leading and trailing spaces - invisible, and load-bearing.
  // Whatever the composition looks like, nothing may sit immediately after
  // `text-xl` inside a single token.
  const { container } = renderSidebar("data");

  const glued = [...container.querySelectorAll("[class]")]
    .flatMap((element) => tokensOf(element as HTMLElement))
    .filter((token) => /text-xl./.test(token));

  expect(glued).toEqual([]);
});

it("gives every button the base classes", () => {
  // Both, because the point of the fix is that it changes no appearance: the
  // utilities that applied before must still be discrete tokens after.
  renderSidebar();

  for (const name of BUTTONS) {
    const tokens = tokensOf(screen.getByRole("button", { name }));

    expect(tokens).toContain("text-xl");
    expect(tokens).toContain("text-northeastern-red");
    expect(tokens).toContain("font-montserrat");
  }
});

it("marks the selected button bold and underlined", () => {
  renderSidebar("data");

  const tokens = tokensOf(screen.getByRole("button", { name: "Data" }));

  for (const className of SELECTED_CLASSES) {
    expect(tokens).toContain(className);
  }
});

it("keeps the unselected button unmarked", () => {
  // The other half of "the selection is distinguishable". Without this, a fix
  // that put `selectedButton` on both buttons would pass the test above.
  renderSidebar("data");

  const tokens = tokensOf(screen.getByRole("button", { name: "Management" }));

  for (const className of SELECTED_CLASSES) {
    expect(tokens).not.toContain(className);
  }
});

/**
 * SCRUM-513. Selection here was underline and weight alone - no
 * `aria-pressed` - so both buttons announced identically.
 */
it("offers the Reports tab, and selecting it asks for the reports option (SCRUM-555)", () => {
  const setOption = jest.fn();
  render(<AdminSidebar option="reports" setOption={setOption} />);

  const reports = screen.getByRole("button", { name: "Reports" });
  expect(reports).toHaveAttribute("aria-pressed", "true");

  reports.click();
  expect(setOption).toHaveBeenCalledWith("reports");
});

it("marks exactly the selected button as pressed", () => {
  renderSidebar("data");

  expect(screen.getByRole("button", { name: "Management" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByRole("button", { name: "Data" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
