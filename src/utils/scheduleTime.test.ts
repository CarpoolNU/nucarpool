import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  formatScheduleTime,
  normalizeScheduleTime,
  NO_SCHEDULE_TIME,
  scheduleClockOf,
  scheduleTimeFromClock,
  SCHEDULE_TIMEZONE,
} from "./scheduleTime";

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * `startTime`/`endTime` are `@db.Time(0)` columns holding a UTC time of day, so
 * Prisma hands them back as an epoch-dated `Date`. These build that shape
 * directly, which is what the component actually receives.
 */
const storedAt = (utcHour: number, utcMinute = 0): Date =>
  new Date(Date.UTC(1970, 0, 1, utcHour, utcMinute));

describe("formatScheduleTime", () => {
  it("renders a stored UTC time in Boston local time", () => {
    // 14:00 UTC is the 9:00 AM a Boston student picked in winter.
    expect(formatScheduleTime(storedAt(14))).toBe("9:00 AM");
    expect(formatScheduleTime(storedAt(22))).toBe("5:00 PM");
  });

  it("keeps the minutes", () => {
    expect(formatScheduleTime(storedAt(14, 30))).toBe("9:30 AM");
  });

  describe("early shifts", () => {
    /**
     * The old copies reinterpreted the value as UTC whenever the Boston hour
     * landed in [01:00, 05:00), which is exactly the range a genuine early
     * shift occupies. A 2:00 AM start is stored as 07:00 UTC and used to
     * display as 7:00 AM.
     */
    it("displays a 02:00 start as 02:00", () => {
      expect(formatScheduleTime(storedAt(7))).toBe("2:00 AM");
    });

    it("displays the rest of the range the guess used to capture", () => {
      expect(formatScheduleTime(storedAt(6))).toBe("1:00 AM");
      expect(formatScheduleTime(storedAt(8))).toBe("3:00 AM");
      expect(formatScheduleTime(storedAt(9, 59))).toBe("4:59 AM");
    });

    it("orders the early hours correctly against the rest of the day", () => {
      // A guessed hour broke ordering as well as labelling: 2 AM read as 7 AM,
      // which is after a real 6 AM start rather than before it.
      expect(formatScheduleTime(storedAt(7))).toBe("2:00 AM");
      expect(formatScheduleTime(storedAt(11))).toBe("6:00 AM");
    });
  });

  describe("missing times", () => {
    /**
     * `startTime` and `endTime` are both nullable and `UserCard` renders them
     * unconditionally. The old copies passed `null` straight into `dayjs.tz`,
     * which throws `RangeError: Invalid time value`.
     */
    it("returns a placeholder instead of throwing on null", () => {
      expect(() => formatScheduleTime(null)).not.toThrow();
      expect(formatScheduleTime(null)).toBe(NO_SCHEDULE_TIME);
    });

    it("returns a placeholder for undefined", () => {
      expect(formatScheduleTime(undefined)).toBe(NO_SCHEDULE_TIME);
    });

    it("returns a placeholder for an unparseable date", () => {
      expect(formatScheduleTime(new Date("nonsense"))).toBe(NO_SCHEDULE_TIME);
    });
  });

  it("displays in Boston regardless of where the viewer is", () => {
    // The product is Northeastern co-op students, so a schedule means Boston
    // time whoever is reading it.
    expect(SCHEDULE_TIMEZONE).toBe("America/New_York");
    expect(formatScheduleTime(storedAt(14))).toBe("9:00 AM");
  });
});

/**
 * SCRUM-373. A schedule time is a clock face stored as a UTC time of day, and
 * converting between the two needs an offset that `America/New_York` only has
 * one of in winter. The write path used to take that offset from the day the
 * user was saving and the read path from `1970-01-01`, so anything saved under
 * daylight saving went in an hour early and came back an hour early.
 *
 * Every assertion above builds its input with `Date.UTC(1970, 0, 1, ...)` and
 * therefore exercises only the winter half that already worked — which is why
 * the suite stayed green while the bug shipped. These cover the round trip.
 */
describe("schedule time round trip", () => {
  const JULY = "2026-07-15T00:00:00.000Z"; // EDT, UTC-4
  const JANUARY = "2026-01-15T00:00:00.000Z"; // EST, UTC-5

  /** What a picker anchored on `date` sends for a Boston clock face. */
  const asClientWouldSend = (date: string, hour: number, minute = 0) => {
    const anchored = dayjs.tz(date, SCHEDULE_TIMEZONE);
    return anchored.hour(hour).minute(minute).second(0).toDate().toISOString();
  };

  describe("scheduleTimeFromClock", () => {
    it("stores 9:00 AM as 14:00 UTC", () => {
      // The convention `formatScheduleTime` reads, and the one the winter path
      // already produced. It is now produced in every season.
      expect(scheduleTimeFromClock(9, 0).toISOString()).toBe(
        "1970-01-01T14:00:00.000Z",
      );
    });

    it("keeps minutes, and pads single digits into the parsed string", () => {
      expect(scheduleTimeFromClock(9, 5).toISOString()).toBe(
        "1970-01-01T14:05:00.000Z",
      );
    });

    it("round-trips back through formatScheduleTime for every quarter hour", () => {
      // The picker's `minuteStep` is 15, so this is the whole input space.
      for (let hour = 0; hour < 24; hour++) {
        for (const minute of [0, 15, 30, 45]) {
          const stored = scheduleTimeFromClock(hour, minute);
          const expected = dayjs().hour(hour).minute(minute).format("h:mm A");
          expect(formatScheduleTime(stored)).toBe(expected);
        }
      }
    });
  });

  describe("normalizeScheduleTime", () => {
    it("stores the same value for a July save and a January save", () => {
      // The defect, stated directly: these two differed by an hour.
      const summer = normalizeScheduleTime(asClientWouldSend(JULY, 9));
      const winter = normalizeScheduleTime(asClientWouldSend(JANUARY, 9));

      expect(summer!.toISOString()).toBe("1970-01-01T14:00:00.000Z");
      expect(winter!.toISOString()).toBe(summer!.toISOString());
    });

    it("displays a summer-saved 9:00 AM as 9:00 AM", () => {
      expect(
        formatScheduleTime(normalizeScheduleTime(asClientWouldSend(JULY, 9))),
      ).toBe("9:00 AM");
    });

    it("repairs what a stale client sends, so the fix needs no reload", () => {
      // A cached bundle still anchors a fresh pick on today. Interpreting that
      // instant in Boston at its own date recovers the face the user chose.
      const stale = asClientWouldSend(JULY, 17, 30);
      expect(formatScheduleTime(normalizeScheduleTime(stale))).toBe("5:30 PM");
    });

    it("is idempotent, so re-saving an unchanged profile does not drift", () => {
      const once = normalizeScheduleTime(asClientWouldSend(JULY, 8, 45))!;
      const twice = normalizeScheduleTime(once.toISOString())!;
      const thrice = normalizeScheduleTime(twice.toISOString())!;

      expect(twice.toISOString()).toBe(once.toISOString());
      expect(thrice.toISOString()).toBe(once.toISOString());
    });

    it("leaves an already-correct winter value alone", () => {
      // The deployment-safety property: rows written in winter used this
      // offset already, so nothing that renders correctly today changes.
      const winter = normalizeScheduleTime("1970-01-01T14:00:00.000Z");
      expect(winter!.toISOString()).toBe("1970-01-01T14:00:00.000Z");
    });

    it("returns undefined rather than an Invalid Date", () => {
      // Prisma rejects an Invalid Date with an opaque error, part-way through
      // a transaction that has already written the other profile fields.
      expect(normalizeScheduleTime("nonsense")).toBeUndefined();
      expect(normalizeScheduleTime("")).toBeUndefined();
    });
  });

  describe("scheduleClockOf", () => {
    it("recovers the clock face the picker should redisplay", () => {
      expect(scheduleClockOf(new Date("1970-01-01T14:00:00.000Z"))).toEqual({
        hour: 9,
        minute: 0,
      });
    });

    it("inverts scheduleTimeFromClock", () => {
      for (const [hour, minute] of [
        [0, 0],
        [2, 15],
        [9, 30],
        [17, 45],
        [23, 45],
      ]) {
        expect(scheduleClockOf(scheduleTimeFromClock(hour!, minute!))).toEqual({
          hour,
          minute,
        });
      }
    });
  });
});
