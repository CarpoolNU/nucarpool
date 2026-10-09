/**
 * The day-match filter's rules, in one place for both sides of it.
 *
 * The Explore panel and `calculateScore` must not disagree about when the day
 * filter applies. In particular, "Flex days" with no days selected must not
 * exclude every candidate: the scorer rejects when `bothUsersDays < flexDays`,
 * and with nothing checked `bothUsersDays` is 0 while `flexDays` is at least
 * 1.
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
 * `[""]`, so a filter that records no days would yield `undefined` for six of
 * the seven days. Fed straight into a checkbox's `checked` prop, that leaves
 * six of the day checkboxes **uncontrolled** whenever no days are selected —
 * the initial state on the map page, and permanent for a VIEWER — and React
 * warns about the switch to controlled on the first toggle.
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
 * Mutating the raw `split(",")` would produce a **sparse** array when the
 * string is short — assigning index 3 of a one-element array leaves holes at
 * 1 and 2 — and `Array.prototype.map` preserves holes rather than visiting
 * them, so that would write a string like `"0,,,1"` into filter state.
 * Consumers only treat `"1"` as truthy, but that is not something to rely on
 * silently.
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
 * is no requested set of days for a candidate to match. This is consistent
 * with the rest of `calculateScore`: the day *score* reads
 * `currentUserDays === 0 ? 0`, on the grounds that with no days requested
 * there is no overlap to measure, and every other filter has its own way to
 * mean "any" — the distance tests are skipped at `>= 20`, the time tests at
 * `>= 4`, and the date test at `dateOverlap === 0`. This is the day filter's.
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
 * Clamping is applied to state, not just to the displayed value, so the shown
 * value and the sent/scored value stay identical by construction — a
 * display-only clamp would let the control show one number while a different,
 * unclamped one is sent and scored.
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
