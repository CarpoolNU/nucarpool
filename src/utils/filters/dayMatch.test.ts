import {
  clampFlexDays,
  countSelectedDays,
  dayMatchApplies,
  DAYS_IN_WEEK,
  parseSelectedDays,
  toggleSelectedDay,
} from "./dayMatch";

/**
 * The day-match filter's shared rules.
 *
 * These functions exist so the Explore panel and `calculateScore` share one
 * definition of this arithmetic instead of each keeping their own. The
 * assertions that matter most are the zero-days ones, the case most likely to
 * put the two out of sync.
 */

const WEEKDAYS = "0,1,1,1,1,1,0";
const NONE = "0,0,0,0,0,0,0";

describe("countSelectedDays", () => {
  it("counts the selected days", () => {
    expect(countSelectedDays(WEEKDAYS)).toBe(5);
    expect(countSelectedDays("1,1,1,1,1,1,1")).toBe(7);
  });

  it("counts an all-zero string as none", () => {
    expect(countSelectedDays(NONE)).toBe(0);
  });

  it("counts the empty string as none", () => {
    // The initial filter state on the map page, and what a VIEWER keeps.
    expect(countSelectedDays("")).toBe(0);
  });

  it("treats a truncated string as working none of the missing days", () => {
    // The same reading `dayConversion` gives it, so the panel and the scorer
    // agree about a malformed value too.
    expect(countSelectedDays("0,1")).toBe(1);
  });
});

describe("parseSelectedDays", () => {
  it("always returns seven flags", () => {
    // "".split(",") is [""], so indices 1..6 would come back undefined
    // without padding, which would hand checked={undefined} to six of the
    // seven day checkboxes - making them uncontrolled for exactly the state
    // the map starts in and a VIEWER never leaves.
    for (const daysWorking of ["", "0,1", NONE, WEEKDAYS, "1,1,1,1,1,1,1"]) {
      const days = parseSelectedDays(daysWorking);

      expect(days).toHaveLength(DAYS_IN_WEEK);
      expect(days.every((day) => typeof day === "boolean")).toBe(true);
    }
  });

  it("reads the flags in order, Sunday first", () => {
    expect(parseSelectedDays(WEEKDAYS)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it('treats anything that is not "1" as unselected', () => {
    expect(parseSelectedDays("1,,x,0,true,2,1")).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("toggleSelectedDay", () => {
  it("turns a day on and off again", () => {
    expect(toggleSelectedDay(NONE, 1)).toBe("0,1,0,0,0,0,0");
    expect(toggleSelectedDay("0,1,0,0,0,0,0", 1)).toBe(NONE);
  });

  it("writes seven fields even from an empty string", () => {
    // Mutating the raw split(",") would leave holes, and map preserves holes
    // rather than visiting them, so without going through parseSelectedDays
    // the joined string would carry empty fields like "0,,,1". Only "1" is
    // truthy to any consumer, but that is not something to rely on silently.
    expect(toggleSelectedDay("", 3)).toBe("0,0,0,1,0,0,0");
  });

  it("leaves the other days alone", () => {
    expect(toggleSelectedDay(WEEKDAYS, 6)).toBe("0,1,1,1,1,1,1");
    expect(toggleSelectedDay(WEEKDAYS, 3)).toBe("0,1,1,0,1,1,0");
  });

  it("agrees with countSelectedDays about what it wrote", () => {
    // The two are used together on every toggle - the count feeds the flex-days
    // clamp - so a disagreement would silently mis-clamp.
    let daysWorking = "";

    for (const index of [1, 2, 3]) {
      daysWorking = toggleSelectedDay(daysWorking, index);
    }

    expect(countSelectedDays(daysWorking)).toBe(3);
    expect(daysWorking).toBe("0,1,1,1,0,0,0");
  });
});

describe("dayMatchApplies", () => {
  it("does not apply in Any mode", () => {
    expect(dayMatchApplies(0, 5)).toBe(false);
  });

  it("applies in Exact and Flex mode when days are selected", () => {
    expect(dayMatchApplies(1, 5)).toBe(true);
    expect(dayMatchApplies(2, 5)).toBe(true);
  });

  it("does not apply in either mode when no days are selected", () => {
    // Both modes must behave this way: with no days selected, bothUsersDays
    // is 0, which is below any flexDays, so without this check "Flex days"
    // chosen before picking days would return an empty list and an empty map.
    expect(dayMatchApplies(1, 0)).toBe(false);
    expect(dayMatchApplies(2, 0)).toBe(false);
  });

  it("does not apply for a mode value it does not know", () => {
    // The routers take `days: z.number()` with no enum, so 3 is reachable
    // over the wire. Unknown means unconstrained, not "reject everyone".
    expect(dayMatchApplies(3, 5)).toBe(false);
    expect(dayMatchApplies(-1, 5)).toBe(false);
  });
});

describe("clampFlexDays", () => {
  it("holds the value inside the days actually selected", () => {
    expect(clampFlexDays(5, 7)).toBe(5);
    expect(clampFlexDays(9, 7)).toBe(7);
  });

  it("returns 1 when no days are selected", () => {
    // Not 0. "Share at least zero days" is not a filter anyone means, and
    // `dayMatchApplies` is what makes the mode inert here — so this value is
    // never consulted, and it stays the honest minimum rather than a sentinel.
    expect(clampFlexDays(1, 0)).toBe(1);
    expect(clampFlexDays(4, 0)).toBe(1);
  });

  it("collapses to 1 when exactly one day is selected", () => {
    expect(clampFlexDays(1, 1)).toBe(1);
    expect(clampFlexDays(6, 1)).toBe(1);
  });

  it("never returns less than 1", () => {
    expect(clampFlexDays(0, 7)).toBe(1);
    expect(clampFlexDays(-3, 7)).toBe(1);
  });

  it("falls back to 1 for a cleared number input", () => {
    // parseInt("", 10) is NaN; falling back to 1 keeps state in sync with
    // what the emptied box shows, rather than leaving a stale unclamped value.
    expect(clampFlexDays(NaN, 7)).toBe(1);
  });

  it("keeps the result a whole number", () => {
    // `max` is an integer in the markup, but nothing stops a caller.
    expect(clampFlexDays(2.7, 7)).toBe(2);
  });

  it("is idempotent, so clamping a clamped value changes nothing", () => {
    // State is re-clamped on every day toggle, so a non-idempotent clamp would
    // drift the value downward as the user checked days on and off.
    for (const count of [0, 1, 3, 7]) {
      for (const requested of [0, 1, 4, 9]) {
        const once = clampFlexDays(requested, count);

        expect(clampFlexDays(once, count)).toBe(once);
      }
    }
  });
});
