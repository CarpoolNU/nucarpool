import {
  formatScheduleTime,
  NO_SCHEDULE_TIME,
  SCHEDULE_TIMEZONE,
} from "./scheduleTime";

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
