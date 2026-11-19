/**
 * What a start/end pair means as a shift, and when to ask the user about it.
 *
 * **Why this exists (SCRUM-732).** The schedule pickers are 12-hour with a
 * separate AM/PM column, and an empty antd picker opens on midnight. A user who
 * clicked only an hour therefore got AM: an end meant as 5:00 PM was stored as
 * 5:00 AM, and nothing afterwards questioned it, because `onboardSchema`
 * deliberately accepts an end before the start - that is how a night shift
 * reads. 8 of the first 123 schedules written after SCRUM-373 have that shape.
 * Those rows hold exactly what was picked, so no repair can recover them; the
 * only remedy is to stop producing them.
 *
 * Three things here do that, and none of them rejects anything:
 *
 *  - `scheduleOpenTime` opens an empty picker on a plausible time instead of
 *    midnight, so an hour-only pick lands on the meridiem a shift usually has.
 *  - `describeSchedule` states the shift beside the pickers - "the next day
 *    (20 hours)" - so a wrong AM or PM is visible before anything is saved.
 *  - `planOvernightScheduleQuestion` decides when a save must stop and ask.
 *
 * **Every comparison is on the Boston wall clock**, through the same
 * conversion the display uses. The stored value is a UTC time of day, and
 * Boston's evening is the start of the UTC day: 9:00 AM stores `14:00` and
 * 8:00 PM stores `01:00`, so comparing what is stored would call an ordinary
 * 9-to-8 shift overnight.
 */

import {
  formatScheduleTime,
  scheduleTimeFromWallClock,
  toPickerScheduleTime,
} from "./scheduleTime";

const MINUTES_PER_DAY = 24 * 60;

/**
 * The length an empty picker assumes a shift has, when it seeds one end from
 * the other. Eight hours, because it is the most common span in production:
 * 8:00 AM-4:00 PM and 9:00 AM-5:00 PM are the two most frequent schedules.
 */
const TYPICAL_SHIFT_MINUTES = 8 * 60;

/** Where an empty start picker opens when there is no end to work from. */
const DEFAULT_START_MINUTE = 9 * 60;

type ScheduleTime = Date | null | undefined;

/** A start/end pair, as the form and the stored row both hold it. */
export interface SchedulePair {
  startTime?: ScheduleTime;
  endTime?: ScheduleTime;
}

/** Minutes past Boston midnight, or `null` for a missing or unusable time. */
export const scheduleMinuteOfDay = (time: ScheduleTime): number | null => {
  const boston = toPickerScheduleTime(time);

  return boston ? boston.hour() * 60 + boston.minute() : null;
};

export interface ScheduleSpan {
  /**
   * `overnight` when the end is earlier than the start, `fullDay` when they
   * are equal - the end is then read as the same time the next day, which is
   * how `minutesApart` already treats a pair, round the clock.
   */
  kind: "sameDay" | "overnight" | "fullDay";
  /** The shift's length, 1 to 1440. */
  minutes: number;
}

/** The shift a start/end pair describes, or `null` until both are set. */
export const scheduleSpan = (
  startTime: ScheduleTime,
  endTime: ScheduleTime,
): ScheduleSpan | null => {
  const start = scheduleMinuteOfDay(startTime);
  const end = scheduleMinuteOfDay(endTime);

  if (start === null || end === null) {
    return null;
  }

  if (end === start) {
    return { kind: "fullDay", minutes: MINUTES_PER_DAY };
  }

  if (end < start) {
    return { kind: "overnight", minutes: end + MINUTES_PER_DAY - start };
  }

  return { kind: "sameDay", minutes: end - start };
};

/** "8 hours", "1 hour 30 minutes", "45 minutes". */
export const formatShiftLength = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (rest > 0) {
    parts.push(`${rest} ${rest === 1 ? "minute" : "minutes"}`);
  }

  return parts.join(" ");
};

/**
 * The shift in words - "9:00 AM to 5:00 AM the next day (20 hours)" - or
 * `null` until both ends are set.
 *
 * The length is the part that does the work. A mis-picked meridiem moves an
 * end by twelve hours, so an eight-hour day reads as twenty hours, or four,
 * and that is hard to miss in a way "5:00 AM" in a small input is not.
 */
export const describeSchedule = (
  startTime: ScheduleTime,
  endTime: ScheduleTime,
): string | null => {
  const span = scheduleSpan(startTime, endTime);

  if (!span) {
    return null;
  }

  const nextDay = span.kind === "sameDay" ? "" : " the next day";

  return `${formatScheduleTime(startTime)} to ${formatScheduleTime(endTime)}${nextDay} (${formatShiftLength(span.minutes)})`;
};

/**
 * Where an **empty** picker's panel opens, as a stored-shape value.
 *
 * An empty end opens eight hours after the start, and an empty start eight
 * hours before the end; with neither set they open on 9:00 AM and 5:00 PM. A
 * night shift is served too: after a 10:00 PM start, an hour-only end pick
 * lands on the morning.
 *
 * **This is a default, and it is a deliberate one.** antd's own was midnight,
 * which made AM the silent answer for every hour-only pick. A seed cannot be
 * right for everyone, so it only decides the meridiem an hour-only click
 * inherits - it is never saved on its own (opening and closing a panel
 * commits nothing) - and the overnight question below still stops any pair
 * whose end lands before its start.
 *
 * **Returned stored-shaped, epoch-dated, for a second reason: the date.** A
 * fresh antd pick is built on *today* in the browser's zone, and on a
 * spring-forward day 2:00-2:59 AM does not exist there, so a 2:00 AM pick
 * from a US browser silently became 3:00 AM. Seeding from this value means a
 * fresh pick is built on the anchor date, the way an edit of an existing time
 * always was, and the day it is made stops mattering.
 */
export const scheduleOpenTime = (
  field: "startTime" | "endTime",
  otherTime: ScheduleTime,
): Date => {
  const other = scheduleMinuteOfDay(otherTime);

  const minute =
    field === "startTime"
      ? other === null
        ? DEFAULT_START_MINUTE
        : other - TYPICAL_SHIFT_MINUTES
      : (other ?? DEFAULT_START_MINUTE) + TYPICAL_SHIFT_MINUTES;

  const wrapped =
    ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  return scheduleTimeFromWallClock(Math.floor(wrapped / 60), wrapped % 60);
};

/** What a save asks before it goes ahead with an end at or before its start. */
export interface OvernightScheduleQuestion {
  kind: "overnight" | "fullDay";
  /** Both times as the user sees them, e.g. "9:00 AM". */
  start: string;
  end: string;
  /** The shift's length in words, e.g. "20 hours". */
  length: string;
}

/** Whether two pairs name the same Boston wall-clock start and end. */
export const samePair = (a: SchedulePair, b: SchedulePair): boolean =>
  scheduleMinuteOfDay(a.startTime) === scheduleMinuteOfDay(b.startTime) &&
  scheduleMinuteOfDay(a.endTime) === scheduleMinuteOfDay(b.endTime);

/**
 * Whether saving `schedule` must first ask the user to confirm it, and what to
 * ask; `null` means save without a word.
 *
 * Asks when the end is at or before the start - which is every AM/PM mis-pick
 * of either end, since a wrong meridiem moves one end twelve hours - **and**
 * the pair differs both from what is stored and from what this user has
 * already confirmed.
 *
 *  - **Never a rejection.** A real night shift is asked about exactly once and
 *    saved as picked. The data cannot tell a night shift from a mis-pick;
 *    only the person can.
 *  - **Never about a schedule the user did not touch.** A stored pair that
 *    reads as overnight - a night shift, or a legacy value - saves untouched
 *    alongside an unrelated edit with no question. Production holds dozens of
 *    such rows, and an owner editing a bio is no position to adjudicate them.
 *  - **Never twice about one answer**, so a save the server then refuses does
 *    not ask again when it is retried.
 */
export const planOvernightScheduleQuestion = ({
  schedule,
  stored,
  confirmed,
}: {
  schedule: SchedulePair;
  stored: SchedulePair;
  confirmed: SchedulePair | null;
}): OvernightScheduleQuestion | null => {
  const span = scheduleSpan(schedule.startTime, schedule.endTime);

  if (!span || span.kind === "sameDay") {
    return null;
  }

  if (samePair(schedule, stored)) {
    return null;
  }

  if (confirmed && samePair(schedule, confirmed)) {
    return null;
  }

  return {
    kind: span.kind,
    start: formatScheduleTime(schedule.startTime),
    end: formatScheduleTime(schedule.endTime),
    length: formatShiftLength(span.minutes),
  };
};
