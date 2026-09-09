import {
  planCoopRangeNotice,
  REVERSED_COOP_RANGE_NOTICE,
} from "./coopRangeNotice";

/**
 * The decision behind SCRUM-407's user-facing half.
 *
 * The value of these is mostly in what they prove the notice does *not* fire
 * for. It is deliberately narrower than "validate the form on mount", and the
 * cases below are the ones that would make it noise instead of a signal: a
 * one-month co-op, a VIEWER with no dates, and a refetch.
 */
const march = new Date("2026-03-31T00:00:00.000Z");
const june = new Date("2026-06-30T00:00:00.000Z");

describe("planCoopRangeNotice", () => {
  it("flags a range that ends before it starts", () => {
    expect(
      planCoopRangeNotice({
        coopStartDate: june,
        coopEndDate: march,
        alreadyShown: false,
      }),
    ).toEqual({
      tab: "account",
      field: "coopEndDate",
      message: REVERSED_COOP_RANGE_NOTICE,
    });
  });

  it("routes to the tab that actually shows the field", () => {
    // `AccountSection` holds both date pickers and renders
    // `errors.coopEndDate.message`. A notice pointing anywhere else would be
    // an instruction the user cannot follow.
    const notice = planCoopRangeNotice({
      coopStartDate: june,
      coopEndDate: march,
      alreadyShown: false,
    });

    expect(notice?.tab).toBe("account");
    expect(notice?.field).toBe("coopEndDate");
  });

  it("says what the cost was, not just what the rule is", () => {
    const notice = planCoopRangeNotice({
      coopStartDate: june,
      coopEndDate: march,
      alreadyShown: false,
    });

    expect(notice?.message).toContain("not appearing");
  });

  it("stays quiet for a forward range", () => {
    expect(
      planCoopRangeNotice({
        coopStartDate: march,
        coopEndDate: june,
        alreadyShown: false,
      }),
    ).toBeNull();
  });

  it("stays quiet for a one-month co-op", () => {
    // Both pickers are month-granularity and `handleMonthChange` stores the
    // last day of the month chosen, so a single-month co-op stores the same
    // date twice. Only a strict inversion is wrong, and treating equality as a
    // defect would flag every one of them.
    expect(
      planCoopRangeNotice({
        coopStartDate: march,
        coopEndDate: march,
        alreadyShown: false,
      }),
    ).toBeNull();
  });

  it.each([
    ["no dates at all", null, null],
    ["only a start date", june, null],
    ["only an end date", null, march],
  ])("stays quiet with %s", (_name, start, end) => {
    // A VIEWER legitimately has neither, and a half-filled pair is a different
    // problem that `onboardSchema` already names on save.
    expect(
      planCoopRangeNotice({
        coopStartDate: start,
        coopEndDate: end,
        alreadyShown: false,
      }),
    ).toBeNull();
  });

  it("stays quiet on undefined, not just null", () => {
    // `user.me` returns a flattened shape assembled by hand, so a field can
    // arrive undefined rather than null.
    expect(
      planCoopRangeNotice({
        coopStartDate: undefined,
        coopEndDate: undefined,
        alreadyShown: false,
      }),
    ).toBeNull();
  });

  it("fires once, not on every refetch", () => {
    // The effect that reads the user re-runs whenever `user` changes, which
    // includes after a save. Yanking someone back to the Account tab each time
    // would be its own defect.
    expect(
      planCoopRangeNotice({
        coopStartDate: june,
        coopEndDate: march,
        alreadyShown: true,
      }),
    ).toBeNull();
  });
});
