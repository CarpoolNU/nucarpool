import dayjs, { type Dayjs } from "dayjs";
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
 * The date every schedule time is resolved against, on **both** the write and
 * the read side.
 *
 * `startTime`/`endTime` are `@db.Time(0)` — a time of day with no date — so
 * turning "9:00 AM in Boston" into a stored value requires picking a UTC
 * offset, and Boston has two. `America/New_York` is UTC-5 in winter and UTC-4
 * under daylight saving, so the offset can only be chosen by naming a date.
 *
 * Reading always named one: Prisma hands the column back as
 * `1970-01-01T<hh:mm>Z`, so `dayjs.tz` resolved the zone on 1 January 1970 —
 * always EST. Writing named a different one: the picker returned an instant on
 * *the day the user saved*, so a July save resolved at EDT and stored 9:00 AM
 * as `13:00` where January stored it as `14:00`. The two halves therefore
 * disagreed for the roughly two-thirds of the year DST covers, and one
 * wall-clock time had two stored forms depending on nothing the user could see
 * (SCRUM-373).
 *
 * Pinning both sides here is what makes the round trip exact. The value is the
 * epoch deliberately, because that is the anchor the read side already had:
 * every correctly-stored row predating the fix stays correct, and the repair in
 * SCRUM-374 is confined to rows written under DST rather than to every row in
 * the table.
 */
export const SCHEDULE_ANCHOR_DATE = "1970-01-01";

/** Shown when a user has no schedule recorded. */
export const NO_SCHEDULE_TIME = "Not set";

/**
 * A stored schedule time as a Boston wall clock, or `null` if there isn't one.
 *
 * The shared half of `formatScheduleTime` and `toPickerScheduleTime`: both need
 * the stored instant expressed in `SCHEDULE_TIMEZONE`, one to format it and one
 * to hand it to antd. Because every stored value is epoch-dated, the zone
 * resolves at `SCHEDULE_ANCHOR_DATE` — which is the point.
 */
const toScheduleZone = (time: Date | null | undefined): Dayjs | null => {
  // Checked before the conversion, not after: `dayjs.tz` throws on an
  // unusable value rather than returning an invalid dayjs to test.
  if (!time || Number.isNaN(new Date(time).getTime())) {
    return null;
  }

  return dayjs.tz(time, SCHEDULE_TIMEZONE);
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
  const boston = toScheduleZone(time);

  return boston ? boston.format("h:mm A") : NO_SCHEDULE_TIME;
};

/**
 * Turns what the user picked into the value stored in `startTime`/`endTime`.
 *
 * **Reads the wall clock, not the instant.** antd hands back a `Dayjs` carrying
 * a full date, and which date that is varies: today for a first-time pick,
 * `SCHEDULE_ANCHOR_DATE` when editing a value that already exists. The instant
 * therefore encodes whichever offset that date happened to fall under, which is
 * the whole of SCRUM-373. Taking `.hour()` and `.minute()` — the digits the user
 * actually saw in the input — and rebuilding them at the anchor discards that
 * date entirely.
 *
 * Two consequences worth having:
 *
 *   - **The picker's own anchor date stops mattering.** Editing an existing time
 *     and setting a fresh one now produce the same stored value, without
 *     depending on any assumption about which date antd chose.
 *   - **The viewer's timezone stops mattering.** The digits are interpreted as
 *     Boston time whoever picked them, so a student onboarding from California
 *     stores the schedule they typed rather than one shifted by three hours.
 */
export const toStoredScheduleTime = (
  picked: Dayjs | null | undefined,
): Date | null => {
  if (!picked || !picked.isValid()) {
    return null;
  }

  const hour = String(picked.hour()).padStart(2, "0");
  const minute = String(picked.minute()).padStart(2, "0");

  const boston = dayjs.tz(
    `${SCHEDULE_ANCHOR_DATE} ${hour}:${minute}`,
    SCHEDULE_TIMEZONE,
  );

  // Re-seated onto the anchor date *in UTC*, because Boston is behind UTC: a
  // wall clock of 19:00 or later is already the next UTC day, so the instant
  // above would land on 1970-01-02. The stored column is unaffected either way
  // — `@db.Time(0)` keeps the time of day and discards the date — but the
  // in-memory value is compared and round-tripped, and Prisma reads these rows
  // back epoch-dated. Normalising here makes the value this produces
  // byte-identical to the value that comes back out, so loading a profile and
  // saving it untouched is genuinely a no-op.
  return dayjs
    .utc(SCHEDULE_ANCHOR_DATE)
    .hour(boston.utc().hour())
    .minute(boston.utc().minute())
    .toDate();
};

/**
 * The inverse: a stored schedule time as a value antd's `TimePicker` can show.
 *
 * Needed because the obvious `dayjs(stored)` renders the instant in the
 * *browser's* zone, so the same row displayed 9:00 AM in Boston and 6:00 AM in
 * California. Anchoring in `SCHEDULE_TIMEZONE` makes the picker agree with
 * `formatScheduleTime` and with `toStoredScheduleTime`, so opening a profile and
 * saving it unchanged is a no-op rather than a silent rewrite.
 */
export const toPickerScheduleTime = (
  stored: Date | null | undefined,
): Dayjs | null => toScheduleZone(stored);

/**
 * Message shown when a non-VIEWER tries to save without a schedule.
 *
 * Mirrors what `onboardSchema` already tells the form, so a hand-rolled client
 * gets the same answer as the UI - see the note on `user.edit`'s `superRefine`.
 */
export const SCHEDULE_TIME_REQUIRED_MESSAGE =
  "A schedule is required unless you are browsing as a viewer";

/**
 * A schedule time on its way to `user.edit`, preserving the difference between
 * "not supplied" and "clear it".
 *
 * `startTime: userInfo.startTime?.toISOString()` collapsed the two, because
 * optional chaining on `null` yields `undefined`. The form models a cleared
 * pick as `null` - `toStoredScheduleTime` returns it - so the user's intent to
 * clear was discarded before the request left the browser, and Prisma then
 * read the `undefined` on the server as "leave this column alone" (SCRUM-387).
 *
 * Three states, all meaningful:
 *
 *  - `undefined` -> the field was not part of this edit; leave it alone.
 *  - `null` -> the user cleared it; write `NULL`.
 *  - a `Date` -> the picked time, as ISO.
 */
export const toScheduleTimeInput = (
  time: Date | null | undefined,
): string | null | undefined => (time === null ? null : time?.toISOString());

/**
 * The server side of the same three states, on the way into Prisma.
 *
 * The distinction is not cosmetic: **Prisma treats `undefined` in an `update`
 * as "omit this field"**, so returning `undefined` for a cleared time is what
 * made clearing impossible. `null` is what actually writes `NULL`.
 *
 * An unparseable string yields `null` rather than an `Invalid Date`, which
 * MySQL would reject at write time with a `P2000`-style failure well after the
 * UI reported success. The input is `z.string()`, so this is the malformed
 * rather than the missing case.
 */
export const fromScheduleTimeInput = (
  value: string | null | undefined,
): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === "") {
    return null;
  }

  const parsed = new Date(Date.parse(value));

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
