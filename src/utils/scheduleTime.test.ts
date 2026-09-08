import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  formatScheduleTime,
  NO_SCHEDULE_TIME,
  SCHEDULE_ANCHOR_DATE,
  SCHEDULE_TIMEZONE,
  toPickerScheduleTime,
  toStoredScheduleTime,
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

/**
 * What antd hands `onChange`: a `Dayjs` carrying a full date, whose UTC instant
 * depends on the offset in force on that date.
 *
 * Built with an explicit zone rather than a bare `dayjs()` so the season is a
 * property of the test rather than of `jest.shared.config.js`'s `TZ`. In
 * `America/New_York`, 9:00 AM is 14:00Z in January and 13:00Z in July — that
 * gap is the bug, and these two values are what carry it into the assertions.
 */
const pickedOn = (day: string, wallClock: string) =>
  dayjs.tz(`${day} ${wallClock}`, SCHEDULE_TIMEZONE);

describe("formatScheduleTime", () => {
  it("renders a stored UTC time in Boston local time", () => {
    // 14:00 UTC is 9:00 AM in Boston at the anchor date's offset, which is now
    // the offset the write path uses too, in every season (SCRUM-373).
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
 * SCRUM-373. The write path used to resolve Boston's offset from whatever date
 * the picker happened to be anchored on, while the read path always resolved it
 * on `SCHEDULE_ANCHOR_DATE`. These pin the property that closes the gap: what
 * gets stored depends on the digits the user picked and on nothing else.
 */
describe("toStoredScheduleTime", () => {
  const WINTER = "2026-01-15";
  const SUMMER = "2026-07-15";

  it("stores the same value for the same wall clock in either season", () => {
    // The headline assertion. Before the fix these differed by an hour, and
    // two students with identical schedules scored 60 minutes apart.
    const winter = toStoredScheduleTime(pickedOn(WINTER, "09:00"));
    const summer = toStoredScheduleTime(pickedOn(SUMMER, "09:00"));

    expect(winter).toEqual(summer);
    expect(winter).toEqual(storedAt(14));
  });

  it("is fed genuinely different offsets, so the helper is doing the work", () => {
    // Guards the test itself: if both inputs resolved to one offset the
    // assertion above would pass without proving anything. This is the raw
    // `.toDate()` the component used to send.
    const utcTimeOfDay = (day: string) =>
      pickedOn(day, "09:00").toDate().toISOString().slice(11, 16);

    expect(utcTimeOfDay(WINTER)).toBe("14:00");
    expect(utcTimeOfDay(SUMMER)).toBe("13:00");
  });

  it("holds across the whole day, not just the morning", () => {
    for (const wallClock of ["00:00", "08:30", "12:00", "17:00", "23:45"]) {
      expect(toStoredScheduleTime(pickedOn(SUMMER, wallClock))).toEqual(
        toStoredScheduleTime(pickedOn(WINTER, wallClock)),
      );
    }
  });

  it("anchors on SCHEDULE_ANCHOR_DATE", () => {
    const stored = toStoredScheduleTime(pickedOn(SUMMER, "09:00"));

    expect(stored?.toISOString().slice(0, 10)).toBe(SCHEDULE_ANCHOR_DATE);
  });

  /**
   * The compounding half of SCRUM-373: antd anchors a fresh pick on today and
   * an edit on the date of the existing value, so the same user performing the
   * same action stored two different times. Reading the wall clock makes the
   * anchor date irrelevant, which is also why this no longer depends on an
   * assumption about which date antd chooses.
   */
  it("stores the same value whether the pick is fresh or an edit", () => {
    const fresh = toStoredScheduleTime(pickedOn(SUMMER, "09:00"));
    const edit = toStoredScheduleTime(pickedOn(SCHEDULE_ANCHOR_DATE, "09:00"));

    expect(fresh).toEqual(edit);
  });

  it("ignores the picker's date entirely", () => {
    const days = ["1970-01-01", "2020-03-08", "2026-07-15", "2031-11-02"];
    const stored = days.map((day) =>
      toStoredScheduleTime(pickedOn(day, "09:00")),
    );

    expect(new Set(stored.map((d) => d?.getTime())).size).toBe(1);
  });

  it("returns null for no pick", () => {
    // The field is nullable and antd passes null when a value is cleared.
    expect(toStoredScheduleTime(null)).toBeNull();
    expect(toStoredScheduleTime(undefined)).toBeNull();
    expect(toStoredScheduleTime(dayjs("nonsense"))).toBeNull();
  });
});

describe("toPickerScheduleTime", () => {
  it("shows a stored time as its Boston wall clock", () => {
    expect(toPickerScheduleTime(storedAt(14))?.format("h:mm A")).toBe(
      "9:00 AM",
    );
    expect(toPickerScheduleTime(storedAt(7))?.format("h:mm A")).toBe("2:00 AM");
  });

  it("agrees with what the display helper renders", () => {
    // The picker and the cards must never disagree about the same row.
    for (const hour of [0, 7, 14, 22, 23]) {
      expect(toPickerScheduleTime(storedAt(hour))?.format("h:mm A")).toBe(
        formatScheduleTime(storedAt(hour)),
      );
    }
  });

  it("returns null rather than an invalid value", () => {
    expect(toPickerScheduleTime(null)).toBeNull();
    expect(toPickerScheduleTime(undefined)).toBeNull();
    expect(toPickerScheduleTime(new Date("nonsense"))).toBeNull();
  });
});

/**
 * The property that matters to a user: open a profile, save it without touching
 * the schedule, and the stored value is unchanged. Before the fix, doing that
 * during DST shifted the time by an hour every single time.
 */
describe("the schedule time round trip", () => {
  it("survives being loaded into the picker and saved again", () => {
    for (const hour of [0, 7, 9, 14, 17, 22, 23]) {
      const stored = storedAt(hour, 30);
      const reSaved = toStoredScheduleTime(toPickerScheduleTime(stored));

      expect(reSaved).toEqual(stored);
    }
  });

  it("displays the hour the user picked, in either season", () => {
    for (const day of ["2026-01-15", "2026-07-15"]) {
      const stored = toStoredScheduleTime(pickedOn(day, "09:00"));

      expect(formatScheduleTime(stored)).toBe("9:00 AM");
    }
  });

  it("keeps an overnight shift overnight", () => {
    // 22:00 to 06:00 is legal and unvalidated; the anchor must not reorder it.
    const start = toStoredScheduleTime(pickedOn("2026-07-15", "22:00"));
    const end = toStoredScheduleTime(pickedOn("2026-07-15", "06:00"));

    expect(formatScheduleTime(start)).toBe("10:00 PM");
    expect(formatScheduleTime(end)).toBe("6:00 AM");
  });
});
