/**
 * The three group figures the admin dashboard derives from `stats.groups`,
 * defined once here rather than in `AdminData.tsx`, `AdminData.test.tsx`, and
 * `admin.db.test.ts` separately: a change to a derivation can only be made in
 * one place, and no test can recompute the same formula it is meant to be
 * checking.
 */

/**
 * Shown in place of a figure whose denominator is zero.
 *
 * An empty cohort has no percentage, and `0%` would state the opposite of what
 * is true: "no drivers are in a group" rather than "there are no drivers".
 * `summariseConversations` resolves the same situation by returning `0`, which
 * is defensible for a mean of nothing but not for a share of nothing.
 *
 * An em dash, not a hyphen or "N/A" - it is the typographic convention for an
 * absent value and needs no legend.
 */
export const UNDEFINED_STAT = "—";

/**
 * The CSV spelling of {@link UNDEFINED_STAT}: an empty cell.
 *
 * The export is read by spreadsheets, and an em dash in a numeric column makes
 * the whole column text - silently, and after the admin has already built a
 * chart on it. A blank cell is the format's own "no value" and is what Excel,
 * Numbers and pandas all read as missing rather than as zero.
 */
export const UNDEFINED_STAT_CSV = "";

/**
 * A share of `whole`, to one decimal place, as a percentage string.
 *
 * Returns {@link UNDEFINED_STAT} when there is nothing to take a share of.
 * `whole` is a row count, so zero is the only unusable value.
 */
export const percentOf = (part: number, whole: number): string =>
  whole === 0 ? UNDEFINED_STAT : Math.round((part / whole) * 1000) / 10 + "%";

/**
 * Mean riders per group, to one decimal place.
 *
 * `number | string` rather than `number`, because of {@link UNDEFINED_STAT}.
 * `QuickStats` and `QuickStatsCSVInput` carry the same widened type for the
 * same reason; `DisplayBox` already accepts `number | string`, so nothing
 * below the dashboard needs to change.
 */
export const averagePerGroup = (
  part: number,
  groupCount: number,
): number | string =>
  groupCount === 0 ? UNDEFINED_STAT : Math.round((part / groupCount) * 10) / 10;

/**
 * One quick-stats figure as the CSV should carry it.
 *
 * The CSV builder takes the already-derived values rather than recomputing
 * them, so this is where the display spelling becomes the file spelling. It
 * compares against the sentinel rather than re-testing the denominator, which
 * keeps the "is this defined?" decision in exactly one place.
 */
export const forCSV = (value: number | string): number | string =>
  value === UNDEFINED_STAT ? UNDEFINED_STAT_CSV : value;
