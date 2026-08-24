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

/** Shown when a user has no schedule recorded. */
export const NO_SCHEDULE_TIME = "Not set";

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
 * That was a guess about rows written before the timezone standardisation in
 * SCRUM-147 / SCRUM-157, and it silently mislabelled genuine early shifts: a
 * 02:00 start was stored correctly as 07:00 UTC and then displayed as 7:00 AM.
 * Both write paths in the tree store a UTC time of day, so the guess is gone
 * and the value is simply converted (SCRUM-239).
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
