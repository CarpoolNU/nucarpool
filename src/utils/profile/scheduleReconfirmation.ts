/**
 * Whether the profile page should ask this user to confirm the schedule they
 * already have stored, and what to remember once they answer (SCRUM-733).
 *
 * **Why anything is needed.** Until SCRUM-732, an empty schedule picker opened
 * on midnight, so a pick that touched only the hour came out AM: a 9:00 AM
 * start and a click on "5" stored 9:00 AM to 5:00 AM. SCRUM-732 stops new
 * ones, and asks at save time about any pair that ends at or before its start
 * - but only when the user *changed* it, so that nobody editing a bio is made
 * to adjudicate a schedule they did not touch. Every row written before it is
 * therefore never questioned. Those rows hold exactly what their owners
 * picked, so no repair can recover what was meant. Only the owner knows.
 *
 * So this asks, once, and never writes. Confirming changes nothing on the
 * server; a correction is the owner's own save through the normal pickers,
 * which `user.edit` validates as it always has.
 *
 * ## Which schedules are asked about
 *
 * All of these, and nothing else:
 *
 *  1. **A DRIVER or RIDER**, not a VIEWER. A VIEWER's pickers are disabled,
 *     so there would be nothing for them to change.
 *  2. **ACTIVE**, with **a co-op that has not ended** by the same rule
 *     matching uses (`coopIsLiveFilter`). These are the schedules other
 *     students actually see and are matched against. A schedule nobody is
 *     shown does no harm, and asking about it is friction for nothing.
 *  3. **Both times set**, and the pair **ends at or before it starts and runs
 *     longer than 12 hours**. That is `isMisPickShaped`, below.
 *  4. **Not already answered for this exact pair** on this device: confirmed,
 *     or snoozed less than `RECONFIRMATION_SNOOZE_HOURS` ago.
 *
 * Rule 3 is the one that matters, and it is not a guess about which shifts
 * are plausible. A wrong AM or PM moves one end by exactly twelve hours. On a
 * same-day shift `L` hours long, with `L` under 12, that always produces a
 * pair that ends the next day after `L + 12` hours, so more than twelve. A
 * real night shift of twelve hours or less can never reach that span by being
 * read correctly. Put the other way: a pair meets rule 3 **exactly when
 * switching one of its two times between AM and PM would turn it into a
 * same-day shift**. A test checks that equivalence over every quarter-hour
 * pair.
 *
 * Measured on production, 2026-11-18 (`pscale` reader role, aggregates only),
 * among the users rules 1 and 2 admit, the overnight shapes split cleanly.
 * 18 rows run 18 to 21 hours, the mis-pick signature: 15 start between 4:00
 * and 9:30 AM and end between midnight and 5:00 AM, and 3 start after 8:00 PM
 * and end at 4:00 or 5:00 PM. 6 rows run 8 to 8½ hours and start between 9:30
 * and 10:30 PM, four of them 10:30 PM to 6:30 AM: real night shifts by shape.
 * **No live row falls between 8½ and 18 hours**, so where exactly the line
 * sits changes nothing today. It sits at 12 because that is the line the
 * mechanism draws.
 *
 * What rule 3 still cannot do is tell a long real shift from a mis-pick. A
 * real 9:00 AM to 5:00 AM is asked about. That is why the notice asks and
 * never asserts, and why "Yes, these hours are correct" ends it.
 *
 * ## Why a value, not a flag
 *
 * A confirmation names the pair it confirmed, as Boston wall-clock minutes. A
 * plain `confirmed: true` would go on suppressing the notice after the
 * schedule changed. Keyed on the value, it stops matching the moment the
 * stored schedule is anything else, and a different pair is judged afresh.
 * `useScheduleReconfirmationRecord` stores it; this file only decides.
 *
 * **Every comparison is on the Boston wall clock**, through
 * `scheduleMinuteOfDay`, which resolves at `SCHEDULE_ANCHOR_DATE`. Neither the
 * browser's zone nor today's date, DST transition days included, changes
 * which schedules qualify or what the notice says.
 *
 * Pure and separate from `src/pages/profile/index.tsx` for the reason
 * `coopRangeNotice.ts` gives: a decision left inline in that page is a
 * decision nothing can test.
 */

import { Role, Status } from "@prisma/client";
import { z } from "zod";
import { isImplausibleCoopYear } from "../dateUtils";
import {
  describeSchedule,
  scheduleMinuteOfDay,
  scheduleSpan,
  type SchedulePair,
} from "../scheduleSpan";

/**
 * A pair qualifies only when its span is **strictly** longer than this. At
 * exactly 12 hours (7:00 PM to 7:00 AM) a flipped meridiem gives a 24-hour
 * pair, not a same-day shift, so that pair is a real twelve-hour night and is
 * left alone.
 */
export const MIS_PICK_MIN_SPAN_MINUTES = 12 * 60;

/**
 * How long "Remind me later" holds the notice back.
 *
 * Elapsed hours on purpose, not "a week". Nothing here needs a calendar: a
 * snooze that ends at 10:00 rather than 11:00 across a DST change is still
 * seven days. Most co-ops in the cohort end in 2026-12, so a shorter snooze
 * would mostly be nagging, and a longer one would outlast the people it is
 * for.
 */
export const RECONFIRMATION_SNOOZE_HOURS = 7 * 24;

/** A schedule as the record keys it: Boston wall-clock minutes past midnight. */
export interface ScheduleStamp {
  startMinute: number;
  endMinute: number;
}

/**
 * What one device remembers. One slot for each answer, not a history: only
 * the stored pair is ever compared, and a user has one stored pair. Moving to
 * a different overnight pair goes through SCRUM-732's save-time question,
 * which records its own confirmation, so the slot follows the schedule.
 */
export interface ScheduleReconfirmationRecord {
  /** The pair the user said is right, and when they said it. */
  confirmed: (ScheduleStamp & { confirmedAt: string }) | null;
  /** The pair the user asked to be reminded about, and until when to wait. */
  snoozed: (ScheduleStamp & { snoozedUntil: string }) | null;
}

export const EMPTY_RECONFIRMATION_RECORD: ScheduleReconfirmationRecord = {
  confirmed: null,
  snoozed: null,
};

/** The pair as the record keys it, or `null` until both times are usable. */
export const scheduleStamp = ({
  startTime,
  endTime,
}: SchedulePair): ScheduleStamp | null => {
  const startMinute = scheduleMinuteOfDay(startTime);
  const endMinute = scheduleMinuteOfDay(endTime);

  return startMinute === null || endMinute === null
    ? null
    : { startMinute, endMinute };
};

const sameStamp = (a: ScheduleStamp, b: ScheduleStamp): boolean =>
  a.startMinute === b.startMinute && a.endMinute === b.endMinute;

/**
 * Rule 3: the pair ends at or before it starts, and runs longer than twelve
 * hours. Equivalently, one switched AM/PM would make it a same-day shift. See
 * the header for why those are the same thing.
 */
export const isMisPickShaped = (pair: SchedulePair): boolean => {
  const span = scheduleSpan(pair.startTime, pair.endTime);

  return (
    span !== null &&
    span.kind !== "sameDay" &&
    span.minutes > MIS_PICK_MIN_SPAN_MINUTES
  );
};

/**
 * Rule 2's co-op half: the same answer `coopIsLiveFilter` gives the matching
 * query, for one row already in hand. `end_date` is on or after today's UTC
 * day and before the year ceiling. A missing date is not live, as there.
 *
 * Restated rather than imported, because `coopLiveness.ts` is a server module
 * that builds Prisma SQL, and nothing in the browser bundle imports from
 * `src/server/db/`. A test asserts the two agree on either side of both
 * boundaries, so they cannot drift without failing it.
 */
export const isCoopLive = (
  coopEndDate: Date | null | undefined,
  now: Date,
): boolean => {
  if (!coopEndDate || Number.isNaN(new Date(coopEndDate).getTime())) {
    return false;
  }

  const end = new Date(coopEndDate);
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );

  return end.getTime() >= today && !isImplausibleCoopYear(end, now);
};

/** What the notice shows, and the pair its answers apply to. */
export interface ScheduleReconfirmation {
  /** The stored schedule in words: "9:00 AM to 5:00 AM the next day (20 hours)". */
  schedule: string;
  stamp: ScheduleStamp;
}

/**
 * The decision: the notice to show, or `null` for nothing.
 *
 * `record` is the device's remembered answers. The caller passes
 * `EMPTY_RECONFIRMATION_RECORD` when it has none, never a guess.
 */
export const planScheduleReconfirmation = ({
  role,
  status,
  coopEndDate,
  startTime,
  endTime,
  record,
  now,
}: {
  role: Role;
  status: Status;
  coopEndDate: Date | null | undefined;
  startTime: Date | null | undefined;
  endTime: Date | null | undefined;
  record: ScheduleReconfirmationRecord;
  now: Date;
}): ScheduleReconfirmation | null => {
  if (role !== Role.DRIVER && role !== Role.RIDER) {
    return null;
  }

  if (status !== Status.ACTIVE || !isCoopLive(coopEndDate, now)) {
    return null;
  }

  const pair = { startTime, endTime };
  const stamp = scheduleStamp(pair);
  const schedule = describeSchedule(startTime, endTime);

  if (!stamp || !schedule || !isMisPickShaped(pair)) {
    return null;
  }

  if (record.confirmed && sameStamp(record.confirmed, stamp)) {
    return null;
  }

  // An unreadable `snoozedUntil` counts as expired. Asking again is the
  // recoverable mistake; hiding the notice for good is not.
  if (
    record.snoozed &&
    sameStamp(record.snoozed, stamp) &&
    Date.parse(record.snoozed.snoozedUntil) > now.getTime()
  ) {
    return null;
  }

  return { schedule, stamp };
};

/**
 * The record after "Yes, these hours are correct", or after SCRUM-732's "Keep
 * overnight". A snooze on the same pair is cleared: it has been answered.
 */
export const withConfirmation = (
  record: ScheduleReconfirmationRecord,
  stamp: ScheduleStamp,
  now: Date,
): ScheduleReconfirmationRecord => ({
  confirmed: { ...stamp, confirmedAt: now.toISOString() },
  snoozed:
    record.snoozed && sameStamp(record.snoozed, stamp) ? null : record.snoozed,
});

/** The record after "Remind me later". The confirmation slot is untouched. */
export const withSnooze = (
  record: ScheduleReconfirmationRecord,
  stamp: ScheduleStamp,
  now: Date,
): ScheduleReconfirmationRecord => ({
  ...record,
  snoozed: {
    ...stamp,
    snoozedUntil: new Date(
      now.getTime() + RECONFIRMATION_SNOOZE_HOURS * 60 * 60 * 1000,
    ).toISOString(),
  },
});

const minuteOfDay = z.number().int().min(0).max(1439);

const recordSchema = z.object({
  confirmed: z
    .object({
      startMinute: minuteOfDay,
      endMinute: minuteOfDay,
      confirmedAt: z.string(),
    })
    .nullable()
    .catch(null),
  snoozed: z
    .object({
      startMinute: minuteOfDay,
      endMinute: minuteOfDay,
      snoozedUntil: z.string(),
    })
    .nullable()
    .catch(null),
});

/**
 * A stored record read back, tolerating anything. Missing, unparseable or
 * foreign JSON is an empty record, and so is either slot on its own. The
 * failure is always toward *showing* the notice, as in `riderDemand/dismissal.ts`.
 * A user whose answer was lost is asked once more; one whose answer was
 * invented is never asked at all.
 */
export const parseReconfirmationRecord = (
  raw: string | null,
): ScheduleReconfirmationRecord => {
  if (raw === null) {
    return EMPTY_RECONFIRMATION_RECORD;
  }

  try {
    const parsed = recordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_RECONFIRMATION_RECORD;
  } catch {
    return EMPTY_RECONFIRMATION_RECORD;
  }
};
