import { contrastRatio } from "./contrast";

/**
 * SCRUM-515: the two colour pairs the audit found below WCAG AA, after the
 * fix. Each pair's threshold depends on where it renders, not on the hex
 * values themselves - 4.5:1 for body text, 3:1 for the ~19px/700 popover
 * title, per https://www.w3.org/TR/WCAG21/#contrast-minimum.
 *
 * `#57534D` is `text-stone-600`'s sRGB rendering of this project's Tailwind
 * v4 theme value `oklch(44.4% 0.011 73.639)` (src/styles/globals.css via
 * @tailwindcss/postcss) - if that theme value ever changes, this hex needs
 * re-deriving alongside it.
 */
describe("contrastRatio", () => {
  const BODY_TEXT_MIN = 4.5;
  const LARGE_TEXT_MIN = 3;

  it.each([
    [
      "popover description/progress text: white on #C8102E",
      "#FFFFFF",
      "#C8102E",
      BODY_TEXT_MIN,
    ],
    ["popover title: white on #C8102E", "#FFFFFF", "#C8102E", LARGE_TEXT_MIN],
    [
      "message counter, normal: text-stone-600 on white panel",
      "#57534D",
      "#FFFFFF",
      BODY_TEXT_MIN,
    ],
    [
      "message counter, over-limit: text-northeastern-red on white panel",
      "#C8102E",
      "#FFFFFF",
      BODY_TEXT_MIN,
    ],
  ])("%s clears its threshold", (_label, fg, bg, minRatio) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(minRatio);
  });

  it("still fails on the pre-fix colours, as a control", () => {
    // The literal background the popover used before this ticket, and
    // text-stone-400, the counter's pre-fix normal-state colour.
    expect(contrastRatio("#FFFFFF", "#D5706A")).toBeLessThan(BODY_TEXT_MIN);
    expect(contrastRatio("#A8A29E", "#FFFFFF")).toBeLessThan(BODY_TEXT_MIN);
  });

  it("computes the textbook black-on-white ratio of 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });
});
