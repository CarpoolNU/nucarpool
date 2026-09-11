/**
 * The day-match filter's rules, in one place for both sides of it.
 *
 * The Explore panel and `calculateScore` were written against each other by
 * hand, with no shared definition, and drifted in four ways. The
 * worst was that **"Flex days" with no days selected excluded every
 * candidate**: the scorer rejects when `bothUsersDays < flexDays`, and with
 * nothing checked `bothUsersDays` is 0 while `flexDays` is at least 1. The
 * user got an empty list and an empty map with nothing explaining that the
 * filter, rather than the population, was responsible.
 *
 * These helpers exist so that the panel and the scorer cannot disagree about
 * when the day filter applies at all.
 */

/** Sunday through Saturday — the width of a `daysWorking` string. */
export const DAYS_IN_WEEK = 7;

/**
 * A `daysWorking` string as exactly seven booleans.
 *
 * **Always seven**, which the raw `split(",")` is not: `"".split(",")` is
 * `[""]`, so a filter that records no days yielded `undefined` for six of the
 * seven days. The panel fed that straight into a checkbox's `checked` prop, so
 * six of the day checkboxes were **uncontrolled** whenever no days were
 * selected — the initial state on the map page, and permanent for a VIEWER —
 * and React warned about the switch to controlled on the first toggle.
 *
 * @param daysWorking comma-separated flags, `"1"` for selected — index 0 is
 *   Sunday. A short, empty or malformed string reads as "not that day", the
 *   same reading `dayConversion` in `recommendation.ts` gives it.
 */
export const parseSelectedDays = (daysWorking: string): boolean[] => {
  const flags = daysWorking.split(",");

  return Array.from(
    { length: DAYS_IN_WEEK },
    (_, index) => flags[index] === "1",
  );
};

/**
 * `daysWorking` with one day flipped.
 *
 * Goes through `parseSelectedDays` so the result is always seven fields.
 * Mutating the raw `split(",")` produced a **sparse** array when the string was
 * short — assigning index 3 of a one-element array leaves holes at 1 and 2 —
 * and `Array.prototype.map` preserves holes rather than visiting them, so
 * toggling Wednesday on an empty string wrote the literal string `"0,,,1"`
 * into filter state. Every consumer happened to tolerate it, because only
 * `"1"` is truthy to any of them, but nothing guaranteed that.
 *
 * @param daysWorking the current string
 * @param index 0 for Sunday through 6 for Saturday
 */
export const toggleSelectedDay = (
  daysWorking: string,
  index: number,
): string => {
  const days = parseSelectedDays(daysWorking);
  days[index] = !days[index];

  return days.map((selected) => (selected ? "1" : "0")).join(",");
};

/**
 * How many days a `daysWorking` string selects.
 *
 * @param daysWorking comma-separated flags, `"1"` for selected
 */
export const countSelectedDays = (daysWorking: string): number =>
  parseSelectedDays(daysWorking).filter(Boolean).length;

/**
 * Whether the day-match filter constrains anything.
 *
 * **False when no days are selected**, whichever mode is chosen, because there
 * is no requested set of days for a candidate to match. That is the rule the
 * whole ticket turns on, and it is not a new one — it is the rule the rest of
 * this code already follows in two places:
 *
 *  - `calculateScore`'s day *score* has read `currentUserDays === 0 ? 0` since
 *    the NaN fix, on the stated grounds that "with no days requested there is
 *    no overlap to measure";
 *  - `recommendation.test.ts` already asserts "excludes nobody on the day
 *    filter when the filter records no days" — for `days === 1`.
 *
 * Only `days === 2` was left out, and it did the opposite. So this extends a
 * decision the suite already pins rather than making a fresh one.
 *
 * It also matches how every *other* filter in `calculateScore` escapes: the
 * distance tests are skipped at `>= 20`, the time tests at `>= 4`, and the
 * date test at `dateOverlap === 0`. The day filter was the only one with no
 * way to mean "any".
 *
 * @param days the mode — 0 any, 1 exact, 2 flex
 * @param selectedDaysCount days selected in the filter, from
 *   `countSelectedDays`
 */
export const dayMatchApplies = (
  days: number,
  selectedDaysCount: number,
): boolean => (days === 1 || days === 2) && selectedDaysCount > 0;

/**
 * `flexDays` held inside the range the selected days allow.
 *
 * The panel used to clamp this **for display only** — its `value` was
 * `flexDays > selectedDaysCount ? selectedDaysCount : flexDays` while state
 * kept the unclamped number — so with no days selected the control showed `0`
 * and 1 was what got sent and scored. A user looking at the box could not tell
 * why nothing matched. Clamping into state instead keeps the shown value and
 * the sent value identical by construction, which is the property that was
 * missing.
 *
 * A minimum of 1 is kept even with no days selected: "share at least zero
 * days" is not a filter anyone means, and `dayMatchApplies` is what makes the
 * mode inert in that case, not a zero here.
 *
 * @param flexDays the requested minimum shared days; a non-finite value falls
 *   back to 1, since `parseInt` on a cleared number input yields `NaN`
 * @param selectedDaysCount days selected in the filter
 */
export const clampFlexDays = (
  flexDays: number,
  selectedDaysCount: number,
): number => {
  if (!Number.isFinite(flexDays)) {
    return 1;
  }

  return Math.max(1, Math.min(Math.trunc(flexDays), selectedDaysCount));
};
