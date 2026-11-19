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
 * been is an EDT instant — so the *season* is determined without locating the
 * moment. Rows whose span crosses a transition keep the original ambiguity and
 * are left alone.
 *
 * **The season settles the offset only for a fresh pick, so only never-edited
 * rows qualify** (SCRUM-731). An *edit* through the pre-fix picker resolved at
 * the existing value's epoch date, which is in EST, so it stored at the anchor's
 * offset whatever the season and may already be correct. A row written since
 * its creation might hold such an edit. `isProvablyDstWritten` therefore
 * requires `dateModified === dateCreated`, and the span reduces to the instant
 * of creation. The span rule as first written accepted edited rows, which is
 * unsound.
 *
 * **The season is not the offset, and this module needs both.** The pre-fix
 * write path stored `date.toDate()` off the picker — an instant resolved in
 * the *browser's* zone — so the stored value is `typed - browser_offset`. For
 * a user in Boston in July that offset is EDT and the two coincide; for a user
 * typing from California it is PDT and it does not. The span rule says nothing
 * about where anyone was sitting. `isEasternOffsetEvidenced` is the second
 * half, and it reads the user's own `Location` rows. On production two of 223
 * span-provable rows are not Eastern, and the repair harms both — one of them
 * is already correct. See that function for why this is evidence and not
 * proof.
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
  /**
   * The user's two `Location` rows, as the offset evidence below reads them.
   *
   * Nullable because the relation is emulated (`relationMode = "prisma"`), so
   * a missing row is a shape the database permits rather than one the schema
   * rules out. A row with no usable location proves nothing and is excluded.
   */
  companyCoords: LocationCoords | null;
  homeCoords: LocationCoords | null;
};

/** The two columns `isEasternOffsetEvidenced` reads off a `Location`. */
export type LocationCoords = { coordLat: number; coordLng: number };

export type DstScheduleRow = {
  row: ScheduleTimeAuditRow;
  /** What a repair would write in place of `row.startTime`. */
  repairStartTime: Date;
  /** What a repair would write in place of `row.endTime`. */
  repairEndTime: Date;
};

/**
 * The first instant from which a stored schedule time might be correct: the
 * moment SCRUM-373's fix merged (`c68f6da`, 2026-09-08 14:20:43Z).
 *
 * The deploy followed the merge by an amount nothing this code can read
 * records, so a row last saved between the two might have gone through either
 * write path. **The cutoff is therefore the earliest instant the fix could
 * have been live, not a guess at when it was.** Only rows last saved before it
 * are provably pre-fix.
 *
 * The asymmetry runs this way. A cutoff that is *too early* leaves a few
 * broken rows, saved between the merge and the deploy, unrepaired. That is the
 * status quo. A cutoff that is *too late* admits rows saved through the fixed
 * path and rewrites values that are already right, which is the one outcome
 * this repair must not produce. This constant used to sit at 2026-09-14,
 * six days late, on the opposite reading. On production that admitted 11 rows
 * last saved after the merge (SCRUM-731).
 */
export const SCHEDULE_FIX_MERGED_AT = new Date("2026-09-08T14:20:43.000Z");

/**
 * Whether this row has never been written since the insert that created it.
 *
 * Prisma stamps `dateCreated` and `dateModified` with the same instant on
 * create, so the test is equality, with no tolerance. SCRUM-725 measured
 * "never edited" as within five seconds. On production on 2026-11-19 every
 * candidate inside that allowance had a gap of exactly zero, so the strict test
 * selects the same rows and leaves no window for a quick second save.
 *
 * Any later write moves `dateModified`, whatever it changed (see the db
 * README), so this means "nothing has touched the row". That is stricter than
 * "the schedule was not retyped", which is the safe direction.
 */
export const isNeverEdited = (
  row: Pick<ScheduleTimeAuditRow, "dateCreated" | "dateModified">,
): boolean => row.dateModified.getTime() === row.dateCreated.getTime();

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
 * The longitude band treated as evidence of US Eastern time, and the latitude
 * band that keeps it to North America.
 *
 * `America/New_York` reaches roughly -67° at its eastern edge and -85° at its
 * western one, give or take the zone's real political boundary through
 * Indiana, Kentucky, Tennessee and Michigan. The band is deliberately the
 * *narrow* reading of that edge: a row just outside it is left unrepaired,
 * which is the status quo, where a row wrongly inside it is rewritten with an
 * offset that was never applied to it.
 */
export const EASTERN_LONGITUDE = { min: -85.0, max: -66.0 } as const;

/** Keeps the longitude band to the North American landmass. */
export const EASTERN_LATITUDE = { min: 24.0, max: 48.0 } as const;

/** Whether one `Location` sits inside the Eastern band. */
const isEasternCoords = (coords: LocationCoords | null): boolean => {
  if (!coords) {
    return false;
  }

  // `(0, 0)` is the column default, not the Gulf of Guinea. It means the
  // address never geocoded, and `scripts/check-profile-coordinates.ts` owns
  // that population. An unset coordinate is absence of evidence.
  if (coords.coordLat === 0 && coords.coordLng === 0) {
    return false;
  }

  return (
    coords.coordLng >= EASTERN_LONGITUDE.min &&
    coords.coordLng <= EASTERN_LONGITUDE.max &&
    coords.coordLat >= EASTERN_LATITUDE.min &&
    coords.coordLat <= EASTERN_LATITUDE.max
  );
};

/**
 * Whether this row carries evidence that its author was in Eastern time.
 *
 * **This is the check the span rule cannot make, and the repair is wrong
 * without it.** `isProvablyDstWritten` establishes *when* the schedule was
 * authored — somewhere inside one daylight-saving window — and the module
 * above reasons from that to an EDT offset. That step is only sound if the
 * pre-fix write path converted at `America/New_York`. It did not. It stored
 * `date.toDate()` off the antd picker (see SCRUM-373's commit), which is an
 * instant resolved in **the browser's** zone, so the stored value is
 * `typed - browser_offset`. Season and offset are the same thing only for a
 * user who was sitting in Eastern time.
 *
 * Measured on production on 2026-11-17: of 223 rows the span rule selects, two
 * are not Eastern — one Central, one Pacific — and the repair harms both. The
 * Central row is *already correct*, because CDT's -5 is the EST anchor offset;
 * repairing it would move a right value to a wrong one.
 *
 * Both locations must qualify. They agreed for every row measured, so
 * requiring both costs nothing today and refuses the genuinely mixed case
 * rather than picking a side.
 *
 * **Evidence, not proof.** Where somebody lives and works now is not where
 * their browser was when they typed a schedule months ago: a student who
 * onboarded from home in another zone and has since moved to Boston still
 * passes. This narrows the risk; it does not close it. Closing it needs the
 * user asked, which is the ambiguous remainder's answer too.
 */
export const isEasternOffsetEvidenced = (
  row: Pick<ScheduleTimeAuditRow, "companyCoords" | "homeCoords">,
): boolean =>
  isEasternCoords(row.companyCoords) && isEasternCoords(row.homeCoords);

/**
 * Whether this row's schedule provably went in under EDT.
 *
 * **Only a row never edited since creation can qualify** (SCRUM-731). The
 * pre-fix picker wrote two different ways. A *fresh* pick, with no existing
 * value, resolved at today's date, so a summer save converted at EDT. An
 * *edit* of an existing value resolved at that value's own date, which is
 * `1970-01-01` and in EST, so an edited time was stored at the anchor's offset
 * **in every season** and may already be correct. Executing the historical
 * picker shows both behaviours, and production's edited rows skew an hour later
 * than its never-edited ones, which is the signature of EST-stored edits. A row
 * that has been written since its insert might be holding an edit, so it is
 * left alone. Of the 216 rows the span rule alone selected on 2026-11-19, 127
 * were edited.
 *
 * For a never-edited row the authoring moment is its creation. The span tests
 * below still run, on `[dateCreated, dateModified]`, so a row created across a
 * transition is still refused and the rule does not depend on how
 * `isNeverEdited` defines "never".
 *
 * "One window" is daylight saving at both ends **and the same calendar year**.
 * US daylight saving runs March to November and never crosses New Year, so a
 * year holds exactly one window.
 */
export const isProvablyDstWritten = (row: ScheduleTimeAuditRow): boolean => {
  const { dateCreated, dateModified } = row;

  // Equality, so this also refuses a row "modified" before it was created.
  // The bulk load wrote both columns directly, which makes that shape possible.
  if (!isNeverEdited(row)) {
    return false;
  }

  if (
    dateCreated.getTime() < CONVERTING_ERA_BEGAN_AT.getTime() ||
    dateModified.getTime() >= SCHEDULE_FIX_MERGED_AT.getTime() ||
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
 * The rows to repair: schedules provably written under EDT, never edited since
 * creation and saved before the fix merged, on a co-op running at `asOf`, each
 * paired with the value a repair would write.
 *
 * Scoped to running co-ops for the same reason as the wall-clock repair — a
 * student between placements re-enters their schedule when they return, so
 * their row corrects itself at no risk and does not justify an irreversible
 * write.
 *
 * **Wall-clock values are excluded explicitly**, not merely by era. The era
 * bound already keeps them out; carrying a wall clock anyway would mean the
 * row's history is not what this rule assumes, whatever its timestamps say, so
 * it is left to the repair that understands it. On production that exclusion
 * currently removes no rows at all — it is live defence in depth rather than a
 * filter the count depends on.
 *
 * **Rows without Eastern-time evidence are excluded too**, by
 * `isEasternOffsetEvidenced`, because the span proves the season and not the
 * offset the browser applied.
 *
 * Not idempotent by value — a repaired `13:00` becomes `14:00`, which this
 * rule would select again on its timestamps alone. It is idempotent by
 * *write*: the repair moves `dateModified` to now, which is past
 * `SCHEDULE_FIX_MERGED_AT` and also makes the row no longer never-edited, so a
 * second run cannot select the row. That safety lives in the write rather than
 * the value, which is exactly why the script must re-read and re-check every
 * row immediately before writing it.
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
        isEasternOffsetEvidenced(row) &&
        !isWallClockSchedule(row.startTime, row.endTime),
    )
    .map((row) => ({
      row,
      // Both non-null: the filter above rejected the row otherwise.
      repairStartTime: toCanonicalFromEdtScheduleTime(row.startTime as Date),
      repairEndTime: toCanonicalFromEdtScheduleTime(row.endTime as Date),
    }));
