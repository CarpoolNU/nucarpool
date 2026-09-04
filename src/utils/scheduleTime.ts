import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The zone every schedule time is displayed in.
 *
 * NUCarpool matches Northeastern co-op students around Boston, so a schedule is
 * only meaningful in Boston's local time. Times are stored as a UTC time of day
 * and rendered here - see "Schedule times" in `src/server/db/README.md`.
 */
export const SCHEDULE_TIMEZONE = "America/New_York";

/**
 * The date every schedule time is resolved against, in both directions.
 *
 * **This constant is the whole of SCRUM-373.** A schedule time is a clock face,
 * not a moment, but it is stored as one — a `@db.Time(0)` column holding a UTC
 * time of day. Turning a clock face into a UTC time of day requires an offset,
 * and `America/New_York` has two of them: UTC-5 in winter, UTC-4 under daylight
 * saving, which runs from mid-March to early November.
 *
 * The two halves of the round trip used to pick that offset from *different*
 * dates. The write path resolved it against the day the user happened to be
 * saving, because the picker handed back a `Date` on today's date; the read path
 * resolved it against `1970-01-01`, because Prisma returns a `Time` column as an
 * epoch-dated `Date` and `dayjs.tz` resolves a zone at the instant it is given.
 * So a 9:00 AM entered in July was stored as `13:00` and read back as 8:00 AM,
 * while the same 9:00 AM entered in January was stored as `14:00` and read back
 * correctly.
 *
 * Anchoring both directions here removes the disagreement: there is one date, so
 * there is one offset, so the round trip is exact in every season.
 *
 * **Why the epoch and not today.** The read path cannot choose — Prisma gives it
 * an epoch-dated value and nothing records when the row was written — so the
 * write path is the side that has to move. That also makes the change safe to
 * deploy on its own: rows written in winter already used this offset and keep
 * rendering correctly, so nothing that is right today becomes wrong. The rows
 * written under daylight saving stay an hour early until they are repaired,
 * which is a data question tracked separately.
 */
export const SCHEDULE_ANCHOR_DATE = "1970-01-01";

/** Shown when a user has no schedule recorded. */
export const NO_SCHEDULE_TIME = "Not set";

/**
 * The stored value for a clock face the user picked.
 *
 * Takes the hour and minute as they appear on the control rather than a `Date`,
 * because a `Date` has already committed to a zone and a date and this function
 * exists to stop those two things being decided by accident. What the user
 * pointed at is a clock face; this is where it acquires an offset, once.
 *
 * Browser-zone independent by construction: `ControlledTimePicker` reads
 * `.hour()` / `.minute()` off the value antd hands back, which is the face the
 * user actually saw, whatever zone their machine is in. A student saving their
 * schedule from another timezone therefore stores the Boston clock time they
 * selected, not that instant translated out of their own zone.
 */
export const scheduleTimeFromClock = (hour: number, minute: number): Date =>
  dayjs
    .tz(
      `${SCHEDULE_ANCHOR_DATE} ${String(hour).padStart(2, "0")}:${String(
        minute,
      ).padStart(2, "0")}`,
      SCHEDULE_TIMEZONE,
    )
    .toDate();

/**
 * The clock face a stored value represents, for redisplay in the picker.
 *
 * The inverse of `scheduleTimeFromClock`, and the reason the picker does not
 * simply hand the stored `Date` to antd: rendering it would resolve the zone in
 * the *browser's* locale, so the same row would show 9:00 AM in Boston and
 * 2:00 PM on a machine set to UTC.
 */
export const scheduleClockOf = (
  time: Date,
): { hour: number; minute: number } => {
  const local = dayjs.tz(time, SCHEDULE_TIMEZONE);
  return { hour: local.hour(), minute: local.minute() };
};

/**
 * Normalises whatever a client sent into the stored representation.
 *
 * The wire format is an ISO instant, and its date component is whatever the
 * client's picker happened to anchor on — today for a first-time pick, the
 * epoch for an edit of an existing value. Reading that instant back in Boston
 * *at its own date* recovers the clock face the user selected in both cases,
 * and re-anchoring it here fixes the offset for good.
 *
 * That makes this idempotent for a current client and **repairing** for a stale
 * one: a cached bundle still sending `2026-07-15T13:00:00Z` for a 9:00 AM pick
 * resolves to 09:00 Boston on that July date and is stored as `14:00`, the same
 * as a fresh client would send. The fix therefore does not depend on every
 * browser having reloaded, which matters because `user.edit` is the only writer
 * and a wrong value here is invisible until someone reads their own profile.
 *
 * Returns `undefined` for an unparseable string rather than an Invalid Date,
 * which Prisma would reject with an opaque error at the end of a transaction
 * that has already written other fields.
 */
export const normalizeScheduleTime = (iso: string): Date | undefined => {
  // Parsed to a `Date` first, deliberately. `dayjs.tz` overloads on the type of
  // its input: given a string it reads it as *wall time already in* that zone,
  // and given a Date it converts the instant into it. The wire value is an
  // instant, so it has to arrive here as a Date or the offset is applied
  // backwards — silently, and only by an hour, which is exactly the class of
  // bug this ticket exists to remove.
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return undefined;
  }

  const { hour, minute } = scheduleClockOf(instant);
  return scheduleTimeFromClock(hour, minute);
};

/**
 * Renders a stored `startTime`/`endTime` for display.
 *
 * `UserCard` and `ConnectModal` each carried their own copy of this, and both
 * copies reinterpreted the value as UTC whenever the Boston hour landed between
 * 01:00 and 04:59:
 *
 * ```
 * if (hour >= 1 && hour < 5) timeInEST = dayjs.tz(time, "UTC");
 * ```
 *
 * That was a guess about rows written before times were standardised on UTC,
 * and it silently mislabelled genuine early shifts: a 02:00 start was stored
 * correctly as 07:00 UTC and then displayed as 7:00 AM. Both write paths in the
 * tree store a UTC time of day, so the guess is gone and the value is simply
 * converted.
 *
 * Also returns a placeholder rather than throwing on a missing time. The old
 * copies passed `null` straight to `dayjs.tz`, which raises
 * `RangeError: Invalid time value`, and `startTime`/`endTime` are both nullable.
 */
export const formatScheduleTime = (time: Date | null | undefined): string => {
  // Checked before the conversion, not after: `dayjs.tz` throws on an
  // unusable value rather than returning an invalid dayjs to test.
  if (!time || Number.isNaN(new Date(time).getTime())) {
    return NO_SCHEDULE_TIME;
  }

  return dayjs.tz(time, SCHEDULE_TIMEZONE).format("h:mm A");
};
