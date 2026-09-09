import dayjs from "dayjs";
import {
  formatDateToMonth,
  handleMonthPickerChange,
  isReversedCoopRange,
  lastDayOfMonthUTC,
} from "./dateUtils";
import type { OnboardingFormInputs } from "./types";
import type { UseFormSetValue } from "react-hook-form";

/**
 * `coopStartDate`/`coopEndDate` are `@db.Date` columns, and Prisma stores the
 * UTC date of whatever `Date` it is given. What matters here is therefore the
 * UTC day, not the local one.
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

  it("stores the same day whatever offset the picker sat at", () => {
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

/**
 * The profile's antd month picker (SCRUM-393).
 *
 * The picker hands back a `Dayjs` in the user's **local** zone. Before this
 * handler existed both profile paths wrote `date.toDate()` straight into the
 * form, which is local midnight on the first of the month - and since these are
 * `@db.Date` columns, Prisma keeps the UTC day, which east of UTC is the day
 * before, which for the first of a month is *the previous month*.
 *
 * `TZ` cannot be changed from inside a test - V8 caches the zone per isolate,
 * and `jest.shared.config.js` says so at length. So the zone is simulated the
 * only way that works here: by constructing the `Dayjs` at the local wall-clock
 * instant that zone would have produced, and asserting on the UTC day that
 * would be stored. `test.yml` runs the whole suite a second time under
 * `NUCARPOOL_TEST_TZ=America/New_York`, which exercises the real thing.
 */
describe("handleMonthPickerChange", () => {
  const capture = () => {
    const stored: { value: Date | null | undefined } = { value: undefined };
    const setValue = ((_field: string, value: Date | null): void => {
      stored.value = value;
    }) as unknown as UseFormSetValue<OnboardingFormInputs>;

    return { stored, setValue };
  };

  /**
   * What the antd month picker hands back for `month`: local midnight on the
   * first, in whatever zone the run is pinned to.
   *
   * **A second zone cannot be simulated from inside this file.** `TZ` is fixed
   * per isolate before the workers fork - `jest.shared.config.js` explains
   * why - and dayjs's `utcOffset` needs the `utc` plugin, which the app does
   * not load. Constructing the raw instant instead would be worse than
   * useless: `2025-12-31T23:00Z` is a Berlin user's January, but `format`
   * would read it in *this* run's zone and call it December, so the test would
   * assert the opposite of the truth.
   *
   * So the coverage is: this assertion is meaningful in whatever zone the run
   * is in, and `test.yml` runs the whole suite twice - `UTC` and
   * `America/New_York`. A positive offset is the broken direction and is not
   * among them, which is stated here rather than faked.
   */
  const picked = (month: string) => {
    const [year, mo] = month.split("-").map(Number);
    return dayjs(new Date(year!, mo! - 1, 1));
  };

  it("stores the last day of the month chosen", () => {
    const { stored, setValue } = capture();

    handleMonthPickerChange("coopStartDate", setValue)(picked("2026-03"));

    expect(storedDay(stored.value!)).toBe("2026-03-31");
  });

  it.each(["2026-01", "2026-02", "2026-06", "2026-09", "2026-12", "2024-02"])(
    "keeps the month the user picked, for %s",
    (month) => {
      // The property the defect broke. `date.toDate()` stored local midnight on
      // the first, and Prisma keeps the UTC day - which east of UTC is the day
      // before, and the day before the first of a month is the previous month.
      const { stored, setValue } = capture();

      handleMonthPickerChange("coopStartDate", setValue)(picked(month));

      expect(formatDateToMonth(stored.value!)).toBe(month);
    },
  );

  it("stores midnight UTC, so the day cannot drift when it is read back", () => {
    const { stored, setValue } = capture();

    handleMonthPickerChange("coopStartDate", setValue)(picked("2026-01"));

    expect(stored.value!.getUTCHours()).toBe(0);
    expect(stored.value!.getUTCMinutes()).toBe(0);
  });

  it("writes the last day, matching the filters and the db README", () => {
    // Not only the offset. `dateOverlapFilter` compares a candidate's stored
    // dates against filter values that `handleMonthChange` builds as the last
    // of the month, so a first-of-month profile value fails `endDate >= yours`
    // under full overlap for a co-op that is an exact match. Both halves of
    // SCRUM-393 come from the same missing call.
    const { stored, setValue } = capture();

    handleMonthPickerChange("coopEndDate", setValue)(picked("2026-06"));

    expect(storedDay(stored.value!)).toBe(
      storedDay(lastDayOfMonthUTC("2026-06")!),
    );
    expect(storedDay(stored.value!)).not.toBe("2026-06-01");
  });

  it("agrees with the filter panel's handler for the same month", () => {
    // One convention, two controls. If these ever diverge again,
    // `dateOverlapFilter` is comparing values that do not mean the same thing.
    const { stored, setValue } = capture();

    handleMonthPickerChange("coopStartDate", setValue)(picked("2026-04"));

    expect(stored.value!.getTime()).toBe(
      lastDayOfMonthUTC("2026-04")!.getTime(),
    );
  });

  it("handles a leap February", () => {
    const { stored, setValue } = capture();

    handleMonthPickerChange("coopStartDate", setValue)(picked("2024-02"));

    expect(storedDay(stored.value!)).toBe("2024-02-29");
  });

  it("clears the field when the picker is cleared", () => {
    const { stored, setValue } = capture();

    handleMonthPickerChange("coopStartDate", setValue)(null);

    expect(stored.value).toBeNull();
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

/**
 * A reversed co-op range is stored without complaint and then removes the user
 * from every full-overlap search.
 */
describe("isReversedCoopRange", () => {
  it("accepts a forward range", () => {
    expect(
      isReversedCoopRange(
        lastDayOfMonthUTC("2026-01"),
        lastDayOfMonthUTC("2026-06"),
      ),
    ).toBe(false);
  });

  it("rejects an end before the start", () => {
    expect(
      isReversedCoopRange(
        lastDayOfMonthUTC("2027-01"),
        lastDayOfMonthUTC("2026-01"),
      ),
    ).toBe(true);
  });

  it("accepts a single-month co-op", () => {
    // Both pickers are month-granularity and `handleMonthChange` stores the
    // last day of the month chosen, so one month means two identical dates.
    // Rejecting equality would make a one-month co-op unsaveable.
    const march = lastDayOfMonthUTC("2026-03");
    expect(isReversedCoopRange(march, lastDayOfMonthUTC("2026-03"))).toBe(
      false,
    );
    expect(isReversedCoopRange(march, march)).toBe(false);
  });

  it("rejects a same-month inversion by a single day", () => {
    expect(
      isReversedCoopRange(
        new Date("2026-03-31T00:00:00.000Z"),
        new Date("2026-03-30T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("says nothing about a range that is not fully set", () => {
    // Whether both dates are required is `onboardSchema`'s question, and a
    // VIEWER legitimately has neither.
    const day = lastDayOfMonthUTC("2026-01");
    expect(isReversedCoopRange(null, day)).toBe(false);
    expect(isReversedCoopRange(day, null)).toBe(false);
    expect(isReversedCoopRange(null, null)).toBe(false);
    expect(isReversedCoopRange(undefined, undefined)).toBe(false);
  });
});
