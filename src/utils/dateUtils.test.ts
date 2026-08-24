import { formatDateToMonth, lastDayOfMonthUTC } from "./dateUtils";

/**
 * `coopStartDate`/`coopEndDate` are `@db.Date` columns, and Prisma stores the
 * UTC date of whatever `Date` it is given. What matters here is therefore the
 * UTC day, not the local one (SCRUM-239).
 */
const storedDay = (date: Date) => date.toISOString().slice(0, 10);

describe("lastDayOfMonthUTC", () => {
  it("returns the last day of the named month, at midnight UTC", () => {
    expect(storedDay(lastDayOfMonthUTC("2024-03")!)).toBe("2024-03-31");
    expect(storedDay(lastDayOfMonthUTC("2024-04")!)).toBe("2024-04-30");
  });

  it("handles a leap February", () => {
    expect(storedDay(lastDayOfMonthUTC("2024-02")!)).toBe("2024-02-29");
    expect(storedDay(lastDayOfMonthUTC("2023-02")!)).toBe("2023-02-28");
  });

  it("handles December without rolling into the next year", () => {
    expect(storedDay(lastDayOfMonthUTC("2024-12")!)).toBe("2024-12-31");
  });

  it("stores the same day whatever offset the picker sat at (SCRUM-239)", () => {
    // `new Date(year, month, 0)` built local midnight, which is the previous
    // day in UTC for anyone at a positive offset - so choosing March in Berlin
    // recorded 30 March. Building in UTC removes the viewer from the result.
    const utcMidnight = lastDayOfMonthUTC("2024-03")!;

    expect(utcMidnight.getUTCHours()).toBe(0);
    expect(utcMidnight.getUTCDate()).toBe(31);
  });

  it("returns null for a value the month input never produces", () => {
    expect(lastDayOfMonthUTC("")).toBeNull();
    expect(lastDayOfMonthUTC("not-a-month")).toBeNull();
  });
});

describe("formatDateToMonth", () => {
  it("round-trips a month through the picker value", () => {
    expect(formatDateToMonth(lastDayOfMonthUTC("2024-03"))).toBe("2024-03");
    expect(formatDateToMonth(lastDayOfMonthUTC("2024-12"))).toBe("2024-12");
  });

  it("reads the month in UTC, matching how it was written", () => {
    // Reading with local getters would report December for this date anywhere
    // west of Greenwich, sending the picker to the wrong year.
    expect(formatDateToMonth(new Date("2025-01-01T00:00:00.000Z"))).toBe(
      "2025-01",
    );
  });

  it("returns undefined when no date is set", () => {
    expect(formatDateToMonth(null)).toBeUndefined();
  });
});
