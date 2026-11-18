import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  describeSchedule,
  formatShiftLength,
  planOvernightScheduleQuestion,
  scheduleMinuteOfDay,
  scheduleOpenTime,
  scheduleSpan,
} from "./scheduleSpan";
import {
  formatScheduleTime,
  SCHEDULE_TIMEZONE,
  toStoredScheduleTime,
} from "./scheduleTime";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * A Boston wall clock as the form holds it once a picker has written it.
 *
 * Built through `toStoredScheduleTime`, the one function that writes these
 * values, so every case below is a value the app can actually produce.
 */
const at = (wallClock: string): Date => {
  // Parsed by hand: a format string would need `customParseFormat`, which
  // nothing in this node project extends.
  const [, hour, minute, meridiem] = /^(\d+):(\d\d) (AM|PM)$/.exec(wallClock)!;
  const hour24 = (Number(hour) % 12) + (meridiem === "PM" ? 12 : 0);
  const hh = String(hour24).padStart(2, "0");

  return toStoredScheduleTime(
    dayjs.tz(`2026-01-15 ${hh}:${minute}`, SCHEDULE_TIMEZONE),
  )!;
};

/** Exactly what Prisma hands back for a `@db.Time(0)` column. */
const storedAt = (utcHour: number, utcMinute = 0): Date =>
  new Date(Date.UTC(1970, 0, 1, utcHour, utcMinute));

const pair = (start: string, end: string) => ({
  startTime: at(start),
  endTime: at(end),
});

const NOTHING_STORED = { startTime: null, endTime: null };

describe("scheduleMinuteOfDay", () => {
  it("reads the Boston wall clock, not the stored UTC digits", () => {
    expect(scheduleMinuteOfDay(storedAt(14))).toBe(9 * 60);
    // 8:00 PM Boston is 01:00 UTC. Read as UTC it would be 60, the first
    // hour of the day, and every evening shift would look overnight.
    expect(scheduleMinuteOfDay(at("8:00 PM"))).toBe(20 * 60);
  });

  it("is null for a missing or unusable time", () => {
    expect(scheduleMinuteOfDay(null)).toBeNull();
    expect(scheduleMinuteOfDay(undefined)).toBeNull();
    expect(scheduleMinuteOfDay(new Date("nonsense"))).toBeNull();
  });
});

/**
 * The schedules the SCRUM-732 brief names, plus the one the comparison basis
 * gets wrong if it ever reads UTC digits.
 */
describe("scheduleSpan", () => {
  it.each([
    ["9:00 AM", "5:00 PM", "sameDay", 8 * 60],
    ["8:00 AM", "4:00 PM", "sameDay", 8 * 60],
    ["8:00 AM", "4:00 AM", "overnight", 20 * 60],
    ["8:00 PM", "11:00 PM", "sameDay", 3 * 60],
    ["10:00 PM", "6:00 AM", "overnight", 8 * 60],
    ["9:00 AM", "9:00 AM", "fullDay", 24 * 60],
    // 9:00 AM stores 14:00Z and 8:00 PM stores 01:00Z, so a comparison of
    // the stored instants would call this an overnight shift.
    ["9:00 AM", "8:00 PM", "sameDay", 11 * 60],
    ["11:45 PM", "12:00 AM", "overnight", 15],
  ])("%s to %s is %s, %i minutes", (start, end, kind, minutes) => {
    expect(scheduleSpan(at(start), at(end))).toEqual({ kind, minutes });
  });

  it("is null until both ends are set", () => {
    expect(scheduleSpan(at("9:00 AM"), null)).toBeNull();
    expect(scheduleSpan(undefined, at("5:00 PM"))).toBeNull();
  });
});

describe("formatShiftLength", () => {
  it.each([
    [480, "8 hours"],
    [60, "1 hour"],
    [510, "8 hours 30 minutes"],
    [45, "45 minutes"],
    [61, "1 hour 1 minute"],
    [1440, "24 hours"],
  ])("%i minutes reads as %s", (minutes, expected) => {
    expect(formatShiftLength(minutes)).toBe(expected);
  });
});

describe("describeSchedule", () => {
  it("states a same-day shift and its length", () => {
    expect(describeSchedule(at("9:00 AM"), at("5:00 PM"))).toBe(
      "9:00 AM to 5:00 PM (8 hours)",
    );
  });

  it("says when a shift ends the next day, so a mis-picked AM is visible", () => {
    expect(describeSchedule(at("9:00 AM"), at("5:00 AM"))).toBe(
      "9:00 AM to 5:00 AM the next day (20 hours)",
    );
  });

  it("describes equal times as a full day", () => {
    expect(describeSchedule(at("9:00 AM"), at("9:00 AM"))).toBe(
      "9:00 AM to 9:00 AM the next day (24 hours)",
    );
  });

  it("says nothing until both ends are set", () => {
    expect(describeSchedule(at("9:00 AM"), null)).toBeNull();
  });
});

/**
 * Where an empty picker's panel opens. Midnight was antd's own choice, and it
 * is why an hour-only pick came out AM.
 */
describe("scheduleOpenTime", () => {
  it.each([
    ["endTime", null, "5:00 PM"],
    ["endTime", "9:00 AM", "5:00 PM"],
    ["endTime", "8:00 AM", "4:00 PM"],
    ["endTime", "10:00 PM", "6:00 AM"],
    ["endTime", "8:30 PM", "4:30 AM"],
    ["startTime", null, "9:00 AM"],
    ["startTime", "5:00 PM", "9:00 AM"],
    ["startTime", "6:00 AM", "10:00 PM"],
  ] as const)(
    "an empty %s next to %s opens on %s",
    (field, other, expected) => {
      const opensOn = scheduleOpenTime(field, other ? at(other) : null);

      expect(formatScheduleTime(opensOn)).toBe(expected);
    },
  );

  it("returns a value shaped exactly like a stored one", () => {
    // Epoch-dated in UTC, like everything `toStoredScheduleTime` and Prisma
    // produce, so a pick seeded from it goes through the same conversion.
    expect(scheduleOpenTime("endTime", at("9:00 AM"))).toEqual(storedAt(22));
  });
});

describe("planOvernightScheduleQuestion", () => {
  it.each([
    ["9:00 AM", "5:00 PM"],
    ["8:00 AM", "4:00 PM"],
    ["8:00 PM", "11:00 PM"],
  ])("does not ask about %s to %s", (start, end) => {
    expect(
      planOvernightScheduleQuestion({
        schedule: pair(start, end),
        stored: NOTHING_STORED,
        confirmed: null,
      }),
    ).toBeNull();
  });

  it("asks about an end before the start, naming both times and the length", () => {
    expect(
      planOvernightScheduleQuestion({
        schedule: pair("8:00 AM", "4:00 AM"),
        stored: NOTHING_STORED,
        confirmed: null,
      }),
    ).toEqual({
      kind: "overnight",
      start: "8:00 AM",
      end: "4:00 AM",
      length: "20 hours",
    });
  });

  it("asks about a real night shift too, because the data cannot tell them apart", () => {
    expect(
      planOvernightScheduleQuestion({
        schedule: pair("10:00 PM", "6:00 AM"),
        stored: NOTHING_STORED,
        confirmed: null,
      }),
    ).toMatchObject({ kind: "overnight", length: "8 hours" });
  });

  it("asks about equal times as a 24-hour shift", () => {
    expect(
      planOvernightScheduleQuestion({
        schedule: pair("9:00 AM", "9:00 AM"),
        stored: NOTHING_STORED,
        confirmed: null,
      }),
    ).toMatchObject({ kind: "fullDay", length: "24 hours" });
  });

  it("does not ask about a stored schedule the user has not changed", () => {
    // Existing rows hold what their owners picked, including legacy values
    // that read as overnight today. An unrelated edit must not question them.
    const stored = { startTime: storedAt(2), endTime: storedAt(10) };

    expect(
      planOvernightScheduleQuestion({
        schedule: { ...stored },
        stored,
        confirmed: null,
      }),
    ).toBeNull();
  });

  it("compares with the stored row by wall clock, not by object", () => {
    // The form's copy is rebuilt at the anchor; Prisma's is read back. Both are
    // epoch-dated today, but the comparison must not depend on that.
    const stored = { startTime: storedAt(14), endTime: storedAt(10) };

    expect(
      planOvernightScheduleQuestion({
        schedule: pair("9:00 AM", "5:00 AM"),
        stored,
        confirmed: null,
      }),
    ).toBeNull();
  });

  it("asks again once either end of a stored overnight schedule changes", () => {
    const stored = { startTime: storedAt(3), endTime: storedAt(11) };

    expect(
      planOvernightScheduleQuestion({
        schedule: pair("11:00 PM", "6:00 AM"),
        stored,
        confirmed: null,
      }),
    ).toMatchObject({ kind: "overnight", start: "11:00 PM" });
  });

  it("does not ask twice about the pair the user already confirmed", () => {
    const schedule = pair("10:00 PM", "6:00 AM");

    expect(
      planOvernightScheduleQuestion({
        schedule,
        stored: NOTHING_STORED,
        confirmed: pair("10:00 PM", "6:00 AM"),
      }),
    ).toBeNull();
  });

  it("asks again when the confirmed pair has since changed", () => {
    expect(
      planOvernightScheduleQuestion({
        schedule: pair("10:00 PM", "5:00 AM"),
        stored: NOTHING_STORED,
        confirmed: pair("10:00 PM", "6:00 AM"),
      }),
    ).toMatchObject({ end: "5:00 AM" });
  });

  it("leaves an incomplete schedule to the form's own required-field errors", () => {
    expect(
      planOvernightScheduleQuestion({
        schedule: { startTime: at("9:00 AM"), endTime: null },
        stored: NOTHING_STORED,
        confirmed: null,
      }),
    ).toBeNull();
  });
});
