import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { SCHEDULE_TIMEZONE } from "../utils/scheduleTime";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * The Monday-to-Sunday window the weekly admin report digest covers.
 *
 * Two things are deliberately separate here: **which week a digest is about**,
 * which this file derives, and **when the job happens to run**, which it only
 * describes. Getting those the other way round is the defect this module
 * exists to prevent — a digest that covered "everything since I last sent
 * one" would report a different period depending on whether the trigger fired
 * on time, and a run that was a day late would silently widen its own window.
 * A derived window means a late run, a re-run and a retry all cover exactly
 * the same reports.
 *
 * ## Why the zone is `America/New_York` and not a configured value
 *
 * `SCHEDULE_TIMEZONE` is imported rather than respelled. NUCarpool matches
 * Northeastern co-op students around Boston and the project has exactly one
 * local zone; a second constant holding the same string is how the two come
 * to disagree. The database README makes the same argument for schedule
 * times: "Boston is hardcoded deliberately".
 *
 * ## Why this cannot be arithmetic on a fixed number of milliseconds
 *
 * A week in `America/New_York` is 168 hours for most of the year, **167 hours
 * across the March transition and 169 across the November one**. Every figure
 * below was measured against this module rather than reasoned about, because
 * this is the kind of claim that is easy to get backwards.
 *
 * So a boundary cannot be found by stepping a week from the other one:
 *
 *   Mon 2026-10-26 00:00 EDT + 168h  ->  Sun 2026-11-01 23:00 EST  (an hour short)
 *   Mon 2026-03-02 00:00 EST + 168h  ->  Mon 2026-03-09 01:00 EDT  (an hour over)
 *   Mon 2026-11-02 00:00 EST - 168h  ->  Mon 2026-10-26 01:00 EDT  (an hour over)
 *
 * and the *date* a boundary falls on cannot be found that way either.
 * Subtracting six days of real time from Sunday 2026-11-01 23:00 EST — the
 * last evening of the week beginning Monday the 26th — gives Tuesday
 * 2026-10-27 00:00 EDT. The answer is Tuesday; the correct answer is Monday
 * the 26th, and the hour gained at the transition is the whole error.
 *
 * `dayjs`'s own `subtract(6, "day")` on a zone-aware instant does not make
 * that mistake, because it preserves the wall clock rather than the elapsed
 * time. It is still not what this file leans on: that behaviour is a property
 * of the timezone plugin rather than of the arithmetic, and the same call
 * returns an instant carrying the *original* offset (the measured result
 * formats as `Mon 2026-10-26 23:00 -05:00`, on a date that was actually
 * UTC-4). Correct date, hour adrift. Depending on which half of that a reader
 * needs, it is either right or wrong, and that is not a thing to build on.
 *
 * So the day arithmetic runs on a UTC-anchored plain date, where a day is
 * exactly 24 hours by definition and calendar arithmetic is exact with no
 * plugin behaviour in the way, and only the final midnight is resolved back
 * into the zone.
 *
 * ## Why midnight is safe to resolve
 *
 * `dayjs.tz("YYYY-MM-DD 00:00:00", zone)` has to pick an offset, and at a DST
 * transition one local time does not exist and another happens twice. Neither
 * can be midnight in `America/New_York`: US transitions occur at 02:00 local,
 * so 00:00 exists exactly once on every date. A zone that transitioned at
 * midnight would make this ambiguous, which is the reason this paragraph is
 * here rather than the fact being left implicit.
 */

/** The half-open interval a digest covers: `start` inclusive, `end` exclusive. */
export type ReportingWindow = {
  /** Monday 00:00:00.000 in `SCHEDULE_TIMEZONE`, as a UTC instant. */
  start: Date;
  /** The *following* Monday 00:00, exclusive. */
  end: Date;
};

/**
 * How the schedule is spelled, so that the intended cadence is a value tests
 * can assert on rather than a sentence in a comment.
 *
 * **A UTC cron cannot hold a fixed Boston hour**, and this is the trade rather
 * than an oversight. `cron` is interpreted in UTC by every scheduler that
 * takes this spelling, so one expression lands at 08:00 ET for the eight
 * months of daylight time and 07:00 ET for the four months of standard time.
 * Both are Monday morning in Boston, which is all the requirement needs. The
 * alternative — two crons swapped at the transitions — is a second thing to
 * get wrong twice a year in exchange for an hour nobody is waiting on.
 *
 * `etHours` records both of those local hours so a test can derive them from
 * `utcHour` against the real zone and fail if this drifts. Nothing reads these
 * values at runtime: the digest's correctness depends on the *window*, which
 * is derived, and not on when it ran.
 */
export const REPORT_DIGEST_SCHEDULE = {
  /** Monday, in `Date#getUTCDay` / `dayjs#day` numbering where Sunday is 0. */
  weekday: 1,
  /** The UTC hour `cron` fires at. */
  utcHour: 12,
  /** Standard five-field crontab, interpreted in UTC. */
  cron: "0 12 * * 1",
  /** What `utcHour` is in Boston, on each side of the year. */
  etHours: { daylight: 8, standard: 7 },
} as const;

/**
 * A plain calendar date in the target zone, as a UTC-anchored `dayjs`.
 *
 * The conversion to a string and back is what drops the offset: `format` reads
 * the zone-local date, and `dayjs.utc` re-anchors those digits somewhere with
 * no DST, which is the only place day arithmetic is exact. See the note above.
 */
const localCalendarDate = (instant: Date) =>
  dayjs.utc(dayjs(instant).tz(SCHEDULE_TIMEZONE).format("YYYY-MM-DD"));

/** Resolves a plain `YYYY-MM-DD` to that date's midnight in the zone. */
const zoneMidnight = (calendarDate: string): Date =>
  dayjs.tz(`${calendarDate} 00:00:00`, SCHEDULE_TIMEZONE).toDate();

/**
 * The Monday-to-Monday window that `instant` falls inside.
 *
 * Monday is the first day, so an instant on a Sunday belongs to the window
 * that opened six days earlier, not to the one starting the next day.
 */
export const weekContaining = (instant: Date): ReportingWindow => {
  const date = localCalendarDate(instant);

  // `day()` is 0 for Sunday, so Monday is 0 days in and Sunday is 6.
  const daysSinceMonday = (date.day() + 6) % 7;
  const monday = date.subtract(daysSinceMonday, "day");

  return {
    start: zoneMidnight(monday.format("YYYY-MM-DD")),
    end: zoneMidnight(monday.add(7, "day").format("YYYY-MM-DD")),
  };
};

/**
 * The most recent window that has completely finished, as of `now`.
 *
 * This is what a Monday-morning run reports on: the seven days that ended at
 * the midnight just gone, never the partial week in progress.
 *
 * Found by stepping one millisecond back from the current week's start and
 * re-deriving, **not** by subtracting a week. Stepping back 168 hours from
 * Monday 2026-11-02 00:00 EST lands on Monday 2026-10-26 01:00 EDT, an hour
 * inside the week it was meant to open; one millisecond is DST-proof without
 * special-casing either transition, because whatever the offsets the instant
 * immediately before a Monday midnight is inside the previous Monday-to-Sunday
 * week, and `weekContaining` then derives both of its boundaries the same way
 * it derives any other week's.
 *
 * Note that the *correct* behaviour of a run that is a week late is to send
 * the week just gone and leave the missed one unsent. Each window is a row in
 * `report_digest_delivery`, so a skipped week stays unclaimed and can be sent
 * deliberately by naming it; it is not silently folded into the next digest,
 * which would report seven days of reports under a fourteen-day heading.
 */
export const previousCompletedWeek = (now: Date): ReportingWindow =>
  weekContaining(new Date(weekContaining(now).start.getTime() - 1));

/**
 * How the covered week is named in the email.
 *
 * The stored `end` is exclusive — the Monday *after* the week — so the label
 * steps back a millisecond to name the Sunday a reader would call the last
 * day. Writing the exclusive bound into the subject line would describe an
 * eight-day period and invite someone to look for a Monday's reports in the
 * wrong digest.
 *
 * Formatted in `SCHEDULE_TIMEZONE` for the same reason the window is derived
 * there: every recipient is staff for a Boston-area service, and a label that
 * shifted with the server's zone would disagree with the window it names.
 */
export const formatReportingWindow = (window: ReportingWindow): string => {
  const start = dayjs(window.start).tz(SCHEDULE_TIMEZONE);
  const lastDay = dayjs(new Date(window.end.getTime() - 1)).tz(
    SCHEDULE_TIMEZONE,
  );

  const startFormat = start.year() === lastDay.year() ? "D MMM" : "D MMM YYYY";

  return `${start.format(startFormat)} – ${lastDay.format("D MMM YYYY")}`;
};
