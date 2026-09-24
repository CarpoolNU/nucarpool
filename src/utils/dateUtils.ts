import React from "react";
import { UseFormSetValue } from "react-hook-form";
import dayjs, { Dayjs } from "dayjs";
import { Role } from "@prisma/client";
import { OnboardingFormInputs } from "./types";

/**
 * Last day of the month named by a `<input type="month">` value ("2024-03"),
 * at midnight UTC.
 *
 * `coopStartDate`/`coopEndDate` are `@db.Date` columns, and Prisma takes the
 * UTC date out of whatever `Date` it is given. Building the day in local time
 * with `new Date(year, month, 0)` therefore stored the day before whenever the
 * user sat at a positive UTC offset: picking March in Berlin produced midnight
 * local, which is 23:00 UTC on 30 March, so the column recorded the 30th.
 *
 * Constructing the day in UTC makes the stored date the same everywhere.
 */
const lastDayOfMonthUTC = (monthValue: string): Date | null => {
  const [year, month] = monthValue.split("-").map(Number);

  if (!year || !month) {
    return null;
  }

  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0));
};

const handleMonthChange =
  (
    field: "coopStartDate" | "coopEndDate",
    setValue: UseFormSetValue<OnboardingFormInputs>,
  ) =>
  (event: React.ChangeEvent<HTMLInputElement>): void => {
    const lastDay = lastDayOfMonthUTC(event.target.value);

    if (!lastDay) {
      return;
    }

    setValue(field, lastDay, { shouldValidate: true });
  };

/**
 * The same thing for the profile's antd month picker, which hands back a
 * `Dayjs` rather than a change event.
 *
 * **This is the fix for that defect.** Commit 6930f6f (2025-02-23) swapped the
 * profile's `<input type="month">` for `DatePicker picker="month"` and wrote
 * the new value straight through:
 *
 * ```ts
 * onChange={(date) => setValue("coopStartDate", date ? date.toDate() : null)}
 * ```
 *
 * `date.toDate()` is **local** midnight on the first of the month, and
 * `startDate`/`endDate` are `@db.Date`, so Prisma keeps the UTC day. East of
 * UTC that day is the one before — and the day before the first of a month is
 * in the *previous month*. A Berlin user choosing a January–June co-op had
 * December–May stored, and the profile then showed them December.
 *
 * That is precisely the defect `lastDayOfMonthUTC` was written to fix, quoted
 * in its own docstring above. The swap dropped the call and left the import
 * behind, which is why `AccountSection.tsx` reads as though it were still
 * handled.
 *
 * Two things it restores, not one. The offset bug is the visible half; the
 * other is the **convention**. `src/server/db/README.md` records these columns
 * as holding the *last* day of the month chosen, and `dateOverlapFilter`
 * compares a candidate's stored dates against filter values that
 * `handleMonthChange` still builds that way. Storing the first instead skews
 * every comparison by up to a month: under full overlap, a candidate whose
 * co-op is exactly the range you asked for fails `endDate >= yours` and drops
 * out of the results. Both halves come from the same missing call.
 *
 * The month is read off the `Dayjs` in **local** time, deliberately: the user
 * picked it from a local calendar, so those are the year and month they meant.
 * `lastDayOfMonthUTC` then builds the day in UTC, which is the whole point.
 */
const handleMonthPickerChange =
  (
    field: "coopStartDate" | "coopEndDate",
    setValue: UseFormSetValue<OnboardingFormInputs>,
  ) =>
  (date: Dayjs | null): void => {
    if (!date) {
      setValue(field, null, { shouldValidate: true });
      return;
    }

    const lastDay = lastDayOfMonthUTC(date.format("YYYY-MM"));

    if (!lastDay) {
      return;
    }

    setValue(field, lastDay, { shouldValidate: true });
  };

/**
 * Renders a stored co-op date back into the "YYYY-MM" an `<input type="month">`
 * expects. Read in UTC to match how `lastDayOfMonthUTC` writes it, so the month
 * shown is the month chosen regardless of where the reader is.
 */
const formatDateToMonth = (date: Date | null): string | undefined => {
  if (!date) {
    return undefined;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

/**
 * A stored co-op date as an antd month picker's own value, or `null` when the
 * field is empty.
 *
 * **Controlled deliberately.** `AccountSection`'s two month pickers used to
 * take `defaultValue`, which antd reads once at mount and ignores afterwards.
 * `src/pages/profile/index.tsx` calls `reset(...)` on every `user` change -
 * which every save triggers, via a refetch - and `AccountSection` stays
 * mounted across it, since it is gated on `option === "account"` at a fixed
 * position in the tree with no `key`. So the form moved to the saved months
 * and the controls kept displaying the ones they had started with: a user who
 * had just saved was told their change had not taken, which is the opposite
 * of what the database held. `UnsavedModal`'s discard is the same
 * `reset(...)` and had the same outcome (SCRUM-472).
 *
 * `StepThree`'s identical pickers had the opposite problem for the same
 * reason: no `value` at all, so a Previous/Next remount - which unmounts and
 * remounts the step rather than hiding it - restarted antd's internal state at
 * `null` while the form went on holding the dates (SCRUM-512).
 *
 * **`null` rather than `undefined`, and the empty case never reaches
 * `dayjs`.** `formatDateToMonth(null)` is `undefined`, and `dayjs(undefined,
 * format)` is not empty either way: it is `Invalid Date` once
 * `customParseFormat` is extended - which `@rc-component/picker/generate/dayjs`
 * does to the shared dayjs singleton, so importing `DatePicker` anywhere is
 * enough - and *today* when it is not. Neither is "no month chosen". `null` is
 * antd's documented empty value for a controlled picker, and is also what
 * `handleMonthPickerChange` writes when the field is cleared, so the round
 * trip is symmetric.
 *
 * The month is parsed in local time and only ever rendered as `YYYY-MM`, so
 * the displayed month is the stored one in every zone.
 */
const toMonthPickerValue = (date: Date | null | undefined): Dayjs | null => {
  const month = formatDateToMonth(date ?? null);

  return month ? dayjs(month, "YYYY-MM") : null;
};

/**
 * Message for a co-op range whose end falls before its start. Shared so the
 * form and `user.edit` say the same thing.
 */
export const COOP_DATE_ORDER_MESSAGE =
  "End date cannot be before the start date";

/**
 * True when a co-op range runs backwards.
 *
 * A reversed range is accepted by every column involved and then fails silently
 * at match time: `dateOverlapFilter`'s full-overlap branch asks for
 * `startDate <= theirs AND endDate >= theirs`, which no candidate can satisfy
 * once the two are crossed, so the user disappears from every full-overlap
 * search with nothing to indicate why. The partial-overlap negation is likewise
 * arbitrary.
 *
 * **Equal dates are legal.** Both pickers are month-granularity and
 * `handleMonthChange` above stores the *last day* of the month chosen, so a
 * one-month co-op stores the same date twice. Only a strict inversion is
 * rejected.
 *
 * `null` on either side is not this function's problem — `onboardSchema`
 * already requires both for a non-VIEWER, and a VIEWER legitimately has
 * neither.
 */
const isReversedCoopRange = (
  start: Date | null | undefined,
  end: Date | null | undefined,
): boolean => !!start && !!end && end.getTime() < start.getTime();

/**
 * The first calendar year a co-op date may fall in. **Fixed, deliberately.**
 *
 * Production carries 22 searches with years in 1901–1926 and 2069–2074 — the
 * shape of a two-digit year read against the wrong century pivot, though which
 * input produced them is not recorded (SCRUM-550). Nothing refused them:
 * `isReversedCoopRange` catches inversion only, and a 1901→1908 range runs
 * forwards perfectly well.
 *
 * 2022 is the year this repository began, so no co-op in this table can
 * predate it; the earliest real year production holds is 2024 (measured
 * 2026-09-24), and every value below that is 1926 or earlier.
 *
 * Not "ten years ago". A floor that moves with the clock would eventually
 * condemn real co-ops that have simply ended, and `planCoopRangeNotice` would
 * then interrupt those users' profile page to tell them something false.
 */
const EARLIEST_COOP_YEAR = 2022;

/**
 * How far past the current year a co-op date may fall. **Relative,
 * deliberately** — a fixed ceiling would start rejecting real co-ops the year
 * it was overtaken.
 *
 * The latest real year production holds is 2028 and the earliest absurd one
 * 2069, so any width in between separates them. Ten is generous on purpose: a
 * year bound's failure mode is refusing a legitimate co-op, which is worse than
 * admitting an unlikely one.
 */
const COOP_YEARS_AHEAD = 10;

/**
 * The inclusive range of UTC years a co-op date may fall in, as of `now`.
 *
 * UTC because these are `@db.Date` columns written by `lastDayOfMonthUTC`, so
 * the UTC year is the stored one.
 */
const coopYearBounds = (
  now: Date = new Date(),
): { earliest: number; latest: number } => ({
  earliest: EARLIEST_COOP_YEAR,
  latest: now.getUTCFullYear() + COOP_YEARS_AHEAD,
});

/**
 * True when a co-op date's year falls outside `coopYearBounds`.
 *
 * `null` is not this function's problem, for the reason `isReversedCoopRange`
 * gives.
 */
const isImplausibleCoopYear = (
  date: Date | null | undefined,
  now: Date = new Date(),
): boolean => {
  if (!date) {
    return false;
  }

  const year = date.getUTCFullYear();
  const { earliest, latest } = coopYearBounds(now);
  return year < earliest || year > latest;
};

/**
 * Shared so the form and `user.edit` say the same thing. It names the bounds
 * rather than calling the date wrong, because the user can act on a range.
 */
const coopYearMessage = (now: Date = new Date()): string => {
  const { earliest, latest } = coopYearBounds(now);
  return `Pick a year between ${earliest} and ${latest}`;
};

/**
 * Which co-op date fields hold an implausible year, for the two schemas to
 * attach an issue to each.
 *
 * **A VIEWER is exempt**, unlike the ordering check. Both pickers are
 * `disabled` for a VIEWER, yet every profile save re-sends the stored dates, so
 * refusing a VIEWER's stored year would reject every save they make and give
 * them nothing on the page to change. Two of production's 22 are VIEWERs. A
 * VIEWER is browsing rather than matching, so the dates do nothing meanwhile;
 * switching to RIDER or DRIVER enables the pickers and the check with them.
 */
const implausibleCoopYearFields = ({
  role,
  coopStartDate,
  coopEndDate,
  now = new Date(),
}: {
  role: Role;
  coopStartDate: Date | null | undefined;
  coopEndDate: Date | null | undefined;
  now?: Date;
}): ("coopStartDate" | "coopEndDate")[] => {
  if (role === Role.VIEWER) {
    return [];
  }

  const fields: ("coopStartDate" | "coopEndDate")[] = [];
  if (isImplausibleCoopYear(coopStartDate, now)) {
    fields.push("coopStartDate");
  }
  if (isImplausibleCoopYear(coopEndDate, now)) {
    fields.push("coopEndDate");
  }
  return fields;
};

export {
  handleMonthChange,
  handleMonthPickerChange,
  formatDateToMonth,
  lastDayOfMonthUTC,
  isReversedCoopRange,
  coopYearBounds,
  isImplausibleCoopYear,
  coopYearMessage,
  implausibleCoopYearFields,
  toMonthPickerValue,
};
