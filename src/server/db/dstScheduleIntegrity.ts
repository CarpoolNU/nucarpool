/**
 * Schedule-time integrity: finding the rows written under daylight saving
 * before the fixed anchor shipped, which are stored exactly one hour early.
 *
 * `toStoredScheduleTime` pins both halves of the round trip to
 * `SCHEDULE_ANCHOR_DATE`, which is in EST. Before that, the write path
 * converted at *the offset in force on the day the user saved*, so a 9:00 AM
 * picked in July became `13:00` where the convention now says `14:00`. Every
 * surface reads it back at the anchor, so those rows display — and match — an
 * hour early. The code fix was not retroactive; these are the rows it left.
 *
 * **This is a different population from `scheduleTimeIntegrity.ts`, and the
 * two must not be confused.** That module owns rows stored as an unconverted
 * wall clock, which are *five* hours out. Applying this repair to one of those
 * would move it from five hours wrong to four. The rules here are written to
 * exclude that population twice over — by era and by value — and the wall-clock
 * rule's band excludes these in turn.
 *
 * ## Why these rows can be repaired when the ticket said they could not
 *
 * SCRUM-374 ruled a repair out because the stored value does not record which
 * offset produced it — `13:00` is equally a correct 8:00 AM and an incorrect
 * 9:00 AM — and because `dateModified` moves on any profile save rather than
 * on a schedule change.
 *
 * Both remain true. The way through is not a better guess at the authoring
 * moment but a way of not needing one. `dateCreated` is `@default(now())` with
 * **no `@updatedAt`**, so it is immutable, and the schedule must have been
 * authored somewhere in `[dateCreated, dateModified]`. When that whole span
 * lies inside a single daylight-saving window, every instant it could have
 * been is an EDT instant — so the offset is determined without locating the
 * moment. Rows whose span crosses a transition keep the original ambiguity and
 * are left alone.
 *
 * Pure, and kept out of the script for the same reason as its siblings: the
 * selection and the repaired value are the parts worth testing, and they test
 * without a database. The reads and writes live in
 * `scripts/repair-dst-schedule-times.ts`.
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  SCHEDULE_TIMEZONE,
  toStoredScheduleTime,
} from "../../utils/scheduleTime";
import {
  isOnCoopAt,
  isWallClockSchedule,
  type ScheduleTimeRow,
} from "./scheduleTimeIntegrity";

// Extended here rather than relied upon transitively. `scheduleTime.ts`
// extends the same two plugins, so importing it would make these calls work by
// side effect — but a module that reads an offset should not depend on another
// module's import order to do it.
dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * A row plus the two timestamps the rule reads.
 *
 * Separate from `ScheduleTimeRow` so the wall-clock repair's `select` does not
 * grow columns it has no use for.
 */
export type ScheduleTimeAuditRow = ScheduleTimeRow & {
  dateCreated: Date;
  dateModified: Date;
};

export type DstScheduleRow = {
  row: ScheduleTimeAuditRow;
  /** What a repair would write in place of `row.startTime`. */
  repairStartTime: Date;
  /** What a repair would write in place of `row.endTime`. */
  repairEndTime: Date;
};

/**
 * The first instant from which a stored schedule time is treated as correct.
 *
 * The fix landed on 2026-09-08 and the deploy followed it. The exact deploy
 * time is not recorded anywhere this code can read, so the cutoff is pushed
 * out to cover it: a row last saved in that gap might have gone through either
 * path, and a row that *might* already be correct is left alone.
 *
 * The asymmetry is deliberate. Setting this too late leaves a handful of
 * broken rows unrepaired, which is the status quo. Setting it too early
 * rewrites rows that are already right, which is the one outcome this repair
 * must not produce.
 */
export const SCHEDULE_FIX_DEPLOYED_AT = new Date("2026-09-14T00:00:00.000Z");

/**
 * The first instant written by an era that converted at all.
 *
 * Before this, the picker stored the typed wall clock untouched — the
 * five-hour defect `scheduleTimeIntegrity.ts` owns. Those rows were written
 * during daylight saving too, so **without this bound the span test below
 * would accept them** and add an hour to a value that is five hours out.
 * This is the most load-bearing exclusion in the module.
 */
export const CONVERTING_ERA_BEGAN_AT = new Date("2024-11-19T00:00:00.000Z");

/**
 * The UTC day every bulk-loaded row carries as its `dateCreated`.
 *
 * 1,887 rows share it. The load reset the timestamps, so for these the span
 * records the import and says nothing about when anyone authored a schedule.
 *
 * The day happens to fall in December, so `isDaylightSaving` would reject
 * these anyway. The exclusion is explicit regardless: it should not take a
 * reader checking a 2025 calendar to see that bulk rows cannot be selected,
 * and it should not quietly start passing if the load is ever re-run in July.
 */
export const BULK_LOAD_DAY = "2025-12-17";

/** `America/New_York`'s UTC offset, in minutes, under daylight saving. */
const EDT_OFFSET_MINUTES = -240;

/**
 * Whether `America/New_York` was on daylight saving at this instant.
 *
 * Asked of the zone rather than of a hard-coded March-to-November window, so
 * the rule holds for any year without this file carrying a transition table it
 * would then have to be trusted to keep up to date.
 */
const isDaylightSaving = (at: Date): boolean =>
  dayjs(at).tz(SCHEDULE_TIMEZONE).utcOffset() === EDT_OFFSET_MINUTES;

/**
 * Whether this row's schedule provably went in under EDT.
 *
 * The authoring moment is unknown but necessarily lies in `[dateCreated,
 * dateModified]`, so the test is on the whole span rather than on a guess at a
 * point inside it: if every instant in the span is EDT, the offset follows.
 *
 * "One window" is daylight saving at both ends **and the same calendar year**.
 * US daylight saving runs March to November and never crosses New Year, so a
 * year holds exactly one window — two EDT instants in one year are in the same
 * window, while two in different years have a winter between them where the
 * schedule could have been retyped under EST.
 */
export const isProvablyDstWritten = (row: ScheduleTimeAuditRow): boolean => {
  const { dateCreated, dateModified } = row;

  // A row cannot have been modified before it existed. Treated as unusable
  // rather than impossible, because the bulk load wrote both columns directly.
  if (dateModified.getTime() < dateCreated.getTime()) {
    return false;
  }

  if (
    dateCreated.getTime() < CONVERTING_ERA_BEGAN_AT.getTime() ||
    dateModified.getTime() >= SCHEDULE_FIX_DEPLOYED_AT.getTime() ||
    dayjs.utc(dateCreated).format("YYYY-MM-DD") === BULK_LOAD_DAY
  ) {
    return false;
  }

  return (
    isDaylightSaving(dateCreated) &&
    isDaylightSaving(dateModified) &&
    dateCreated.getUTCFullYear() === dateModified.getUTCFullYear()
  );
};

/**
 * The stored value a time written under EDT should have had.
 *
 * **Not `+1 hour`.** The stored instant is read back at the offset that
 * produced it to recover the digits the user actually typed, and those digits
 * go through `toStoredScheduleTime` — the profile form's own write path. The
 * one-hour difference is a *consequence* of `SCHEDULE_ANCHOR_DATE` sitting in
 * EST; hard-coding it would become silently wrong the day that anchor moves,
 * and a repaired row would stop being byte-identical to what its owner would
 * store by retyping the same digits today.
 *
 * The `dayjs()` receiver is today's date and is discarded: `toStoredScheduleTime`
 * reads `.hour()` and `.minute()` off it and rebuilds at the anchor.
 */
export const toCanonicalFromEdtScheduleTime = (stored: Date): Date => {
  // `dayjs.utc` so `.hour()` reads the stored digits rather than the runner's
  // zone, and so a value that wraps past midnight still yields the right hour.
  const typed = dayjs.utc(stored).add(EDT_OFFSET_MINUTES, "minute");

  const canonical = toStoredScheduleTime(
    dayjs().hour(typed.hour()).minute(typed.minute()).second(0),
  );

  /* istanbul ignore next -- the input is a real Date, so this cannot be hit */
  if (!canonical) {
    throw new Error("toStoredScheduleTime rejected a stored schedule time");
  }

  return canonical;
};

/**
 * The rows to repair: schedules provably written under EDT, on a co-op running
 * at `asOf`, each paired with the value a repair would write.
 *
 * Scoped to running co-ops for the same reason as the wall-clock repair — a
 * student between placements re-enters their schedule when they return, so
 * their row corrects itself at no risk and does not justify an irreversible
 * write.
 *
 * **Wall-clock values are excluded explicitly**, not merely by era. The era
 * bound already keeps them out; carrying a wall clock anyway would mean the
 * row's history is not what this rule assumes, whatever its timestamps say, so
 * it is left to the repair that understands it.
 *
 * Not idempotent by value — a repaired `13:00` becomes `14:00`, which this
 * rule would select again on its timestamps alone. It is idempotent by
 * *write*: the repair moves `dateModified` to now, which is past
 * `SCHEDULE_FIX_DEPLOYED_AT`, so a second run cannot select the row. That
 * safety lives in the write rather than the value, which is exactly why the
 * script must re-read and re-check every row immediately before writing it.
 */
export const findDstWrittenScheduleRows = (
  rows: readonly ScheduleTimeAuditRow[],
  asOf: Date,
): DstScheduleRow[] =>
  rows
    .filter(
      (row) =>
        row.startTime !== null &&
        row.endTime !== null &&
        isOnCoopAt(row, asOf) &&
        isProvablyDstWritten(row) &&
        !isWallClockSchedule(row.startTime, row.endTime),
    )
    .map((row) => ({
      row,
      // Both non-null: the filter above rejected the row otherwise.
      repairStartTime: toCanonicalFromEdtScheduleTime(row.startTime as Date),
      repairEndTime: toCanonicalFromEdtScheduleTime(row.endTime as Date),
    }));
