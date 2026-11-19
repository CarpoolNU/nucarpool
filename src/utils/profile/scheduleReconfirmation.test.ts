/**
 * Who is asked to confirm a stored schedule (SCRUM-733), and what their answer
 * is remembered as. See `scheduleReconfirmation.ts` for the rules.
 *
 * Times are built the way production stores them: a UTC time of day on
 * 1970-01-01, where Boston is UTC-5. So 9:00 AM is stored `14:00` and 5:00 AM
 * is stored `10:00`.
 */

import { Role, Status } from "@prisma/client";
import {
  coopLivenessBoundary,
  coopYearCeilingBoundary,
} from "../../server/db/coopLiveness";
import { scheduleTimeFromWallClock } from "../scheduleTime";
import {
  EMPTY_RECONFIRMATION_RECORD,
  MIS_PICK_MIN_SPAN_MINUTES,
  RECONFIRMATION_SNOOZE_HOURS,
  isCoopLive,
  isMisPickShaped,
  parseReconfirmationRecord,
  planScheduleReconfirmation,
  scheduleStamp,
  withConfirmation,
  withSnooze,
  type ScheduleReconfirmationRecord,
} from "./scheduleReconfirmation";

/** A stored-shape value for a Boston wall clock, e.g. `at(9)` is 9:00 AM. */
const at = (hour: number, minute = 0): Date =>
  scheduleTimeFromWallClock(hour, minute);

const NOW = new Date("2026-11-18T15:00:00Z");

/** A live RIDER whose stored schedule is 9:00 AM to 5:00 AM. */
const base = {
  role: Role.RIDER as Role,
  status: Status.ACTIVE as Status,
  coopEndDate: new Date("2026-12-31T00:00:00Z") as Date | null,
  startTime: at(9) as Date | null,
  endTime: at(5) as Date | null,
  record: EMPTY_RECONFIRMATION_RECORD,
  now: NOW,
};

const plan = (overrides: Partial<typeof base> = {}) =>
  planScheduleReconfirmation({ ...base, ...overrides });

describe("which stored schedules read as an AM/PM mis-pick", () => {
  it.each([
    // [label, start, end]
    ["9:00 AM to 5:00 AM, the end picked as AM", at(9), at(5)],
    ["8:30 AM to 3:00 AM, the end picked as AM", at(8, 30), at(3)],
    ["8:00 AM to 4:00 AM, the end picked as AM", at(8), at(4)],
    ["9:00 PM to 5:00 PM, the start picked as PM", at(21), at(17)],
    ["1:00 PM to 9:00 AM, either end flipped", at(13), at(9)],
    ["9:00 AM to 9:00 AM, a 24-hour pair", at(9), at(9)],
  ])("asks about %s", (_label, startTime, endTime) => {
    expect(isMisPickShaped({ startTime, endTime })).toBe(true);
  });

  it.each([
    ["10:30 PM to 6:30 AM, a real night shift", at(22, 30), at(6, 30)],
    ["10:00 PM to 6:00 AM, a real night shift", at(22), at(6)],
    // A 12-hour night: flipping either end gives 24 hours, not a day shift.
    ["7:00 PM to 7:00 AM, exactly twelve hours", at(19), at(7)],
    ["11:00 PM to 7:00 AM, a real night shift", at(23), at(7)],
    // Stored `02:00`-`10:00`: a legacy value nobody should be questioned on
    // because it reads as 8 hours overnight.
    ["9:00 PM to 5:00 AM, a legacy eight-hour overnight", at(21), at(5)],
    ["9:00 AM to 5:00 PM, a day shift", at(9), at(17)],
    ["8:00 PM to 11:00 PM, an evening shift", at(20), at(23)],
  ])("does not ask about %s", (_label, startTime, endTime) => {
    expect(isMisPickShaped({ startTime, endTime })).toBe(false);
  });

  it("does not ask while either end is missing or unusable", () => {
    expect(isMisPickShaped({ startTime: null, endTime: at(5) })).toBe(false);
    expect(isMisPickShaped({ startTime: at(9), endTime: undefined })).toBe(
      false,
    );
    expect(
      isMisPickShaped({ startTime: new Date(Number.NaN), endTime: at(5) }),
    ).toBe(false);
  });

  /**
   * The rule's justification, checked rather than argued: a pair qualifies
   * exactly when switching one of its times between AM and PM would make it a
   * same-day shift. Every quarter-hour pair, so 9,216 of them.
   */
  it("qualifies a pair exactly when one AM/PM switch makes it a same-day shift", () => {
    const quarterHours = Array.from({ length: 96 }, (_, i) => i * 15);
    const mismatches: string[] = [];

    for (const start of quarterHours) {
      for (const end of quarterHours) {
        const flips = [
          [(start + 720) % 1440, end],
          [start, (end + 720) % 1440],
        ];
        const oneFlipMakesSameDay = flips.some(([s, e]) => e! > s!);
        const qualifies = isMisPickShaped({
          startTime: at(Math.floor(start / 60), start % 60),
          endTime: at(Math.floor(end / 60), end % 60),
        });

        if (qualifies !== (end <= start && oneFlipMakesSameDay)) {
          mismatches.push(`${start}-${end}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("draws the line strictly above twelve hours", () => {
    expect(MIS_PICK_MIN_SPAN_MINUTES).toBe(720);
    // 6:59 PM to 7:00 AM is 12 h 1 min; 7:00 PM to 7:00 AM is 12 h.
    expect(isMisPickShaped({ startTime: at(18, 59), endTime: at(7) })).toBe(
      true,
    );
    expect(isMisPickShaped({ startTime: at(19), endTime: at(7) })).toBe(false);
  });
});

describe("planScheduleReconfirmation: who is asked", () => {
  it("asks a live RIDER about a mis-pick shape, naming the stored schedule exactly", () => {
    expect(plan()).toEqual({
      schedule: "9:00 AM to 5:00 AM the next day (20 hours)",
      stamp: { startMinute: 540, endMinute: 300 },
    });
  });

  it("asks a live DRIVER too", () => {
    expect(plan({ role: Role.DRIVER })).not.toBeNull();
  });

  it("states a 24-hour pair as stored", () => {
    expect(plan({ startTime: at(9), endTime: at(9) })?.schedule).toBe(
      "9:00 AM to 9:00 AM the next day (24 hours)",
    );
  });

  it.each([
    ["a VIEWER, whose pickers are disabled", { role: Role.VIEWER }],
    ["an INACTIVE user", { status: Status.INACTIVE }],
    [
      "a co-op that ended yesterday",
      { coopEndDate: new Date("2026-11-17T00:00:00Z") },
    ],
    ["no co-op end date", { coopEndDate: null }],
    [
      "an implausible co-op year",
      { coopEndDate: new Date("2069-05-31T00:00:00Z") },
    ],
    ["no start time", { startTime: null }],
    ["no end time", { endTime: null }],
    ["a day shift", { startTime: at(9), endTime: at(17) }],
    ["a real night shift", { startTime: at(22, 30), endTime: at(6, 30) }],
  ])("does not ask %s", (_label, overrides) => {
    expect(plan(overrides)).toBeNull();
  });

  it("still asks on the co-op's last day, which is inclusive", () => {
    expect(
      plan({ coopEndDate: new Date("2026-11-18T00:00:00Z") }),
    ).not.toBeNull();
  });

  it("asks a co-op that has not started yet, which matching already shows", () => {
    expect(
      plan({ coopEndDate: new Date("2027-08-31T00:00:00Z") }),
    ).not.toBeNull();
  });
});

describe("planScheduleReconfirmation: answers already given", () => {
  const stamp = { startMinute: 540, endMinute: 300 };

  it("does not ask again about a pair this device confirmed", () => {
    const record = withConfirmation(EMPTY_RECONFIRMATION_RECORD, stamp, NOW);

    expect(plan({ record })).toBeNull();
  });

  it("asks about a different pair after the schedule changed, despite the confirmation", () => {
    const record = withConfirmation(EMPTY_RECONFIRMATION_RECORD, stamp, NOW);

    expect(plan({ record, startTime: at(8), endTime: at(4) })).toEqual({
      schedule: "8:00 AM to 4:00 AM the next day (20 hours)",
      stamp: { startMinute: 480, endMinute: 240 },
    });
  });

  it("holds a snoozed pair back until the snooze ends, then asks again", () => {
    const record = withSnooze(EMPTY_RECONFIRMATION_RECORD, stamp, NOW);
    const justBefore = new Date(
      NOW.getTime() + RECONFIRMATION_SNOOZE_HOURS * 3600 * 1000 - 1,
    );
    const atEnd = new Date(
      NOW.getTime() + RECONFIRMATION_SNOOZE_HOURS * 3600 * 1000,
    );

    expect(plan({ record })).toBeNull();
    expect(plan({ record, now: justBefore })).toBeNull();
    expect(plan({ record, now: atEnd })).not.toBeNull();
  });

  it("does not let a snooze on one pair hide a different one", () => {
    const record = withSnooze(EMPTY_RECONFIRMATION_RECORD, stamp, NOW);

    expect(plan({ record, startTime: at(8), endTime: at(4) })).not.toBeNull();
  });

  it("treats an unreadable snooze time as expired, so the notice shows", () => {
    const record: ScheduleReconfirmationRecord = {
      confirmed: null,
      snoozed: { ...stamp, snoozedUntil: "not a date" },
    };

    expect(plan({ record })).not.toBeNull();
  });
});

describe("the record", () => {
  const stamp = { startMinute: 540, endMinute: 300 };
  const other = { startMinute: 480, endMinute: 240 };

  it("stamps a pair as Boston wall-clock minutes", () => {
    expect(scheduleStamp({ startTime: at(9), endTime: at(5) })).toEqual(stamp);
    expect(scheduleStamp({ startTime: at(9), endTime: null })).toBeNull();
  });

  it("records when a confirmation was given, and clears a snooze on the same pair", () => {
    const snoozed = withSnooze(EMPTY_RECONFIRMATION_RECORD, stamp, NOW);

    expect(withConfirmation(snoozed, stamp, NOW)).toEqual({
      confirmed: { ...stamp, confirmedAt: "2026-11-18T15:00:00.000Z" },
      snoozed: null,
    });
  });

  it("keeps a snooze on a different pair when confirming", () => {
    const snoozed = withSnooze(EMPTY_RECONFIRMATION_RECORD, other, NOW);

    expect(withConfirmation(snoozed, stamp, NOW).snoozed).toEqual(
      snoozed.snoozed,
    );
  });

  it("snoozes for seven days of elapsed time and leaves a confirmation alone", () => {
    const confirmed = withConfirmation(EMPTY_RECONFIRMATION_RECORD, other, NOW);

    expect(withSnooze(confirmed, stamp, NOW)).toEqual({
      confirmed: confirmed.confirmed,
      snoozed: { ...stamp, snoozedUntil: "2026-11-25T15:00:00.000Z" },
    });
  });

  it("round-trips through JSON", () => {
    const record = withSnooze(
      withConfirmation(EMPTY_RECONFIRMATION_RECORD, stamp, NOW),
      other,
      NOW,
    );

    expect(parseReconfirmationRecord(JSON.stringify(record))).toEqual(record);
  });

  it.each([
    ["nothing stored", null],
    ["not JSON", "{"],
    ["a JSON string", '"confirmed"'],
    ["an array", "[]"],
    [
      "a minute out of range",
      '{"confirmed":{"startMinute":1440,"endMinute":300,"confirmedAt":"x"},"snoozed":null}',
    ],
    [
      "a minute that is not a number",
      '{"confirmed":{"startMinute":"540","endMinute":300,"confirmedAt":"x"}}',
    ],
  ])("reads %s as an empty record, so the notice shows", (_label, raw) => {
    expect(parseReconfirmationRecord(raw)).toEqual(EMPTY_RECONFIRMATION_RECORD);
  });

  it("keeps a valid slot when the other one is damaged", () => {
    const raw = JSON.stringify({
      confirmed: { ...stamp, confirmedAt: "2026-11-18T15:00:00.000Z" },
      snoozed: { startMinute: -1 },
    });

    expect(parseReconfirmationRecord(raw)).toEqual({
      confirmed: { ...stamp, confirmedAt: "2026-11-18T15:00:00.000Z" },
      snoozed: null,
    });
  });
});

/**
 * `isCoopLive` restates `coopIsLiveFilter` for one row on the client, because
 * the browser bundle does not import from `src/server/db/`. This is the
 * control that keeps the two from drifting: the same answer, a millisecond
 * either side of both server boundaries.
 */
describe("isCoopLive agrees with the server's liveness rule", () => {
  const serverSays = (endDate: Date, now: Date): boolean =>
    endDate >= coopLivenessBoundary(now) &&
    endDate < coopYearCeilingBoundary(now);

  it.each([
    "2026-11-18T15:00:00Z",
    "2026-11-18T00:00:00Z",
    "2026-11-18T23:59:59.999Z",
    "2026-12-31T23:59:59.999Z",
    "2027-01-01T00:00:00Z",
  ])("now = %s", (nowIso) => {
    const now = new Date(nowIso);
    const floor = coopLivenessBoundary(now).getTime();
    const ceiling = coopYearCeilingBoundary(now).getTime();
    const ends = [floor - 1, floor, floor + 1, ceiling - 1, ceiling].map(
      (ms) => new Date(ms),
    );

    for (const end of ends) {
      expect([end.toISOString(), isCoopLive(end, now)]).toEqual([
        end.toISOString(),
        serverSays(end, now),
      ]);
    }
  });

  it("is never live without a date", () => {
    expect(isCoopLive(null, NOW)).toBe(false);
    expect(isCoopLive(undefined, NOW)).toBe(false);
    expect(isCoopLive(new Date(Number.NaN), NOW)).toBe(false);
  });
});

/**
 * The schedule is a Boston wall clock resolved at the anchor date, so neither
 * today's date nor its DST state may change who is asked or what they are
 * told. Run under `NUCARPOOL_TEST_TZ` as well to cover the browser's zone;
 * CI's second leg is `America/New_York`.
 */
describe("the date and zone it runs on change nothing", () => {
  it.each([
    ["midwinter", "2026-01-15T15:00:00Z"],
    ["the day before spring-forward", "2026-03-07T15:00:00Z"],
    ["spring-forward day, 2:30 AM Eastern", "2026-03-08T07:30:00Z"],
    ["midsummer", "2026-07-15T15:00:00Z"],
    ["fall-back day, 1:30 AM Eastern", "2026-11-01T05:30:00Z"],
  ])("%s", (_label, nowIso) => {
    const now = new Date(nowIso);
    const coopEndDate = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 31));

    expect(plan({ now, coopEndDate })).toEqual({
      schedule: "9:00 AM to 5:00 AM the next day (20 hours)",
      stamp: { startMinute: 540, endMinute: 300 },
    });
    // A stored 2:00 AM, the hour spring-forward skips, reads as 2:00 AM.
    expect(
      plan({ now, coopEndDate, startTime: at(6), endTime: at(2) })?.schedule,
    ).toBe("6:00 AM to 2:00 AM the next day (20 hours)");
    expect(
      plan({ now, coopEndDate, startTime: at(22), endTime: at(6) }),
    ).toBeNull();
  });
});
