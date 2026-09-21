/**
 * Schedule-time integrity: finding the rows that hold a Boston wall clock
 * where the column is supposed to hold a UTC time of day.
 *
 * `CarpoolSearch.startTime` / `endTime` are `@db.Time(0)` and are documented as
 * UTC (see "Schedule times" in this directory's README). Four successive
 * `ControlledTimePicker` implementations disagreed about that, and the table
 * holds the residue of all four — SCRUM-376 has the full archaeology. Two of
 * the four wrote the wall clock straight through with no conversion at all, so
 * a 9-to-5 is stored as `09:00`-`17:00` and renders as 4:00 AM to 12:00 PM.
 *
 * **This module finds only that class, and deliberately only that class.**
 * The other open defect on SCRUM-376 is a *one-hour* split between rows
 * converted under EDT and rows converted under EST, and the two are not
 * distinguishable from the stored values: `13:00`-`21:00` is equally "9-5
 * written in summer" and "8-4 written in winter". Nothing here tries. A
 * wall-clock row, by contrast, is five hours from any reading that makes sense
 * — `09:00`-`17:00` as UTC is a shift starting at 4:00 AM and ending at noon —
 * which is what makes this class safe to repair and that one not.
 *
 * Scoped to co-ops that are running, because that is the decision recorded on
 * SCRUM-376: a student between placements re-enters their schedule when they
 * come back, so their row does not justify an irreversible write. Production
 * measurement behind that: of 4,173 rows, 283 were on co-op on 2026-09-21 and
 * eight of those were wall clock.
 *
 * Pure, and kept out of the script for the same reason as `seatIntegrity.ts`:
 * the selection and the repaired value are the parts worth testing, and they
 * can be tested without a database. The reads and writes live in
 * `scripts/repair-wallclock-schedule-times.ts`.
 */

import dayjs from "dayjs";
import { toStoredScheduleTime } from "../../utils/scheduleTime";

/** The columns the repair needs to select a row, report it, and write it. */
export type ScheduleTimeRow = {
  id: string;
  userId: string;
  role: string;
  status: string;
  startTime: Date | null;
  endTime: Date | null;
  startDate: Date | null;
  endDate: Date | null;
};

export type WallClockScheduleRow = {
  row: ScheduleTimeRow;
  /** What a repair would write in place of `row.startTime`. */
  repairStartTime: Date;
  /** What a repair would write in place of `row.endTime`. */
  repairEndTime: Date;
};

/**
 * The band a start time must fall in to read as an unconverted wall clock,
 * inclusive of both hours.
 *
 * Narrow on purpose. Widening it costs far more than it gains: every hour
 * added reaches further into the converted population, where the same value
 * has a competing reading that is only one hour out, and writing five hours
 * onto one of those turns a small error into a large one. The edges are where
 * the two readings stop being absurd — a stored `11:00` read as UTC is a 6:00
 * AM start, which is a real shift somebody might work.
 */
const WALL_CLOCK_START_HOURS = { min: 6, max: 10 } as const;

/** The matching band for an end time. See `WALL_CLOCK_START_HOURS`. */
const WALL_CLOCK_END_HOURS = { min: 14, max: 19 } as const;

/**
 * The stored hour of a `@db.Time(0)` value.
 *
 * Read in UTC because that is how the column comes back: Prisma dates these
 * rows to the epoch and the digits live in the UTC fields. Reading them with
 * `getHours()` would return whatever the runner's zone made of that instant,
 * which is how a repair ends up selecting a different set of rows on a laptop
 * than on a CI box.
 */
const storedHour = (time: Date): number => time.getUTCHours();

/**
 * Whether `asOf` falls inside the row's co-op, endpoints included.
 *
 * Compared as calendar dates: `startDate` and `endDate` are `@db.Date`, so
 * Prisma returns them midnight-UTC and a time-of-day comparison would make the
 * last day of a co-op behave differently from every other day.
 */
export const isOnCoopAt = (
  row: Pick<ScheduleTimeRow, "startDate" | "endDate">,
  asOf: Date,
): boolean => {
  if (!row.startDate || !row.endDate) {
    return false;
  }

  const atMidnightUtc = (date: Date): number =>
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

  const on = atMidnightUtc(asOf);

  return atMidnightUtc(row.startDate) <= on && on <= atMidnightUtc(row.endDate);
};

/**
 * Whether the pair reads as a wall clock written straight through.
 *
 * Both ends have to agree. A row where only one end falls in its band is not
 * this defect — it is either a genuine early or late shift or something no
 * rule here should be guessing about — and it is left alone.
 */
export const isWallClockSchedule = (
  startTime: Date | null,
  endTime: Date | null,
): boolean => {
  if (!startTime || !endTime) {
    return false;
  }

  const start = storedHour(startTime);
  const end = storedHour(endTime);

  return (
    start >= WALL_CLOCK_START_HOURS.min &&
    start <= WALL_CLOCK_START_HOURS.max &&
    end >= WALL_CLOCK_END_HOURS.min &&
    end <= WALL_CLOCK_END_HOURS.max
  );
};

/**
 * The stored value a wall-clock time should have had.
 *
 * Delegates to `toStoredScheduleTime` — the profile form's own write path —
 * rather than adding a fixed five hours. The offset is a consequence of
 * `SCHEDULE_ANCHOR_DATE` being in EST, and hard-coding it here would let the
 * repair and the application drift apart the day that anchor changes. Going
 * through the real writer also makes the guarantee exact: a repaired row is
 * byte-identical to what the user would store by retyping the same digits.
 *
 * The `dayjs()` receiver is today's date and is discarded — `toStoredScheduleTime`
 * reads `.hour()` and `.minute()` off it and rebuilds at the anchor, which is
 * the whole point of that function. A 7:00 PM finish therefore lands on
 * `00:00`, the next UTC day, and `@db.Time(0)` keeps only the time of day.
 */
export const toCanonicalScheduleTime = (stored: Date): Date => {
  const canonical = toStoredScheduleTime(
    dayjs().hour(storedHour(stored)).minute(stored.getUTCMinutes()).second(0),
  );

  /* istanbul ignore next -- the input is a real Date, so this cannot be hit */
  if (!canonical) {
    throw new Error("toStoredScheduleTime rejected a stored schedule time");
  }

  return canonical;
};

/**
 * The rows to repair: wall-clock schedules on a co-op that is running at
 * `asOf`, each paired with the value the repair would write.
 *
 * Role and status are deliberately not filtered. A VIEWER or INACTIVE row is
 * invisible to matching today, but its owner still sees it on their own
 * profile, and it becomes visible the moment they change role — leaving it
 * broken only defers the same defect.
 *
 * Idempotent, because a repaired row leaves the band: a start of 06-10 becomes
 * 11-15 and an end of 14-19 becomes 19-00. A second run finds nothing.
 */
export const findWallClockScheduleRows = (
  rows: readonly ScheduleTimeRow[],
  asOf: Date,
): WallClockScheduleRow[] =>
  rows
    .filter(
      (row) =>
        isOnCoopAt(row, asOf) &&
        isWallClockSchedule(row.startTime, row.endTime),
    )
    .map((row) => ({
      row,
      // Both are non-null: `isWallClockSchedule` rejected the pair otherwise.
      repairStartTime: toCanonicalScheduleTime(row.startTime as Date),
      repairEndTime: toCanonicalScheduleTime(row.endTime as Date),
    }));
