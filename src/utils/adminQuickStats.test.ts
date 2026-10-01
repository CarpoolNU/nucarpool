/**
 * The admin dashboard's three group figures, and what they say about an empty
 * cohort.
 *
 * `percent = (part, whole) => Math.round((part / whole) * 1000) / 10 + "%"`
 * divided by zero whenever there were no drivers, no riders or no groups, so
 * the dashboard rendered `NaN%` and the exported CSV carried a literal `NaN`
 * into a column an admin may well have charted.
 *
 * The zero case went uncovered because the formula was written out four times
 * - in the component and verbatim in two test files, which recomputed the very
 * expression they were checking. `NaN` on both sides of the comparison made
 * the assertion pass. Both of those files import from this module now.
 *
 * The table below is the point of the file: every denominator that can be zero
 * in production, checked for a defined result.
 */

import {
  UNDEFINED_STAT,
  UNDEFINED_STAT_CSV,
  averagePerGroup,
  forCSV,
  percentOf,
} from "./adminQuickStats";

describe("percentOf", () => {
  it.each([
    { part: 0, whole: 0, expected: UNDEFINED_STAT, why: "no drivers at all" },
    { part: 5, whole: 0, expected: UNDEFINED_STAT, why: "an impossible row" },
    { part: 0, whole: 10, expected: "0%", why: "a real zero share" },
    { part: 10, whole: 10, expected: "100%", why: "everybody" },
    { part: 1, whole: 3, expected: "33.3%", why: "rounded to one decimal" },
    { part: 2, whole: 3, expected: "66.7%", why: "rounded up" },
    { part: 1, whole: 8, expected: "12.5%", why: "an exact decimal" },
  ])("$part of $whole is $expected — $why", ({ part, whole, expected }) => {
    expect(percentOf(part, whole)).toBe(expected);
  });

  it("never returns NaN for any zero denominator", () => {
    // The defect, stated directly: this is what reached the screen and the CSV.
    expect(percentOf(0, 0)).not.toContain("NaN");
    expect(percentOf(3, 0)).not.toContain("NaN");
  });

  it("distinguishes an empty cohort from a cohort where nobody matched", () => {
    // `0%` for both would have been the cheaper fix and a false statement for
    // the first: there is no share to report when there is no denominator.
    expect(percentOf(0, 0)).toBe(UNDEFINED_STAT);
    expect(percentOf(0, 7)).toBe("0%");
  });
});

describe("averagePerGroup", () => {
  it.each([
    { part: 0, groupCount: 0, expected: UNDEFINED_STAT, why: "no groups" },
    { part: 4, groupCount: 0, expected: UNDEFINED_STAT, why: "no groups" },
    { part: 0, groupCount: 2, expected: 0, why: "groups with no riders" },
    { part: 7, groupCount: 2, expected: 3.5, why: "one decimal place" },
    { part: 1, groupCount: 3, expected: 0.3, why: "rounded down" },
    { part: 2, groupCount: 3, expected: 0.7, why: "rounded up" },
  ])(
    "$part over $groupCount groups is $expected — $why",
    ({ part, groupCount, expected }) => {
      expect(averagePerGroup(part, groupCount)).toBe(expected);
    },
  );

  it("returns a number whenever the figure is defined", () => {
    // The type is `number | string`, which is what the dash cost. A caller
    // formatting the defined case must still get a number.
    expect(typeof averagePerGroup(7, 2)).toBe("number");
    expect(typeof averagePerGroup(7, 0)).toBe("string");
  });
});

describe("forCSV", () => {
  it("writes an undefined figure as an empty cell, not an em dash", () => {
    // An em dash in a numeric column makes the whole column text, silently,
    // after the admin has already built something on it.
    expect(forCSV(UNDEFINED_STAT)).toBe(UNDEFINED_STAT_CSV);
    expect(UNDEFINED_STAT_CSV).toBe("");
  });

  it.each([
    { value: "0%", why: "a real percentage" },
    { value: "33.3%", why: "a rounded percentage" },
    { value: 0, why: "a real zero average" },
    { value: 3.5, why: "a real average" },
  ])("passes $value through unchanged — $why", ({ value }) => {
    expect(forCSV(value)).toBe(value);
  });

  it("does not mistake a legitimate value containing a dash for the sentinel", () => {
    // Guards the identity comparison against being loosened to a substring
    // test, which no current value needs and a negative never could.
    expect(forCSV("-5%")).toBe("-5%");
  });
});
