import { Role } from "@prisma/client";
import {
  IMPLAUSIBLE_COOP_YEAR_NOTICE,
  planCoopRangeNotice,
  REVERSED_COOP_RANGE_NOTICE,
} from "./coopRangeNotice";

/**
 * The decision behind that change's user-facing half.
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
        role: Role.RIDER,
        coopStartDate: june,
        coopEndDate: march,
        alreadyShown: false,
      }),
    ).toEqual({
      tab: "account",
      fields: ["coopEndDate"],
      message: REVERSED_COOP_RANGE_NOTICE,
    });
  });

  it("routes to the tab that actually shows the field", () => {
    // `AccountSection` holds both date pickers and renders
    // `errors.coopEndDate.message`. A notice pointing anywhere else would be
    // an instruction the user cannot follow.
    const notice = planCoopRangeNotice({
      role: Role.RIDER,
      coopStartDate: june,
      coopEndDate: march,
      alreadyShown: false,
    });

    expect(notice?.tab).toBe("account");
    expect(notice?.fields).toEqual(["coopEndDate"]);
  });

  it("says what the cost was, not just what the rule is", () => {
    const notice = planCoopRangeNotice({
      role: Role.RIDER,
      coopStartDate: june,
      coopEndDate: march,
      alreadyShown: false,
    });

    expect(notice?.message).toContain("not appearing");
  });

  it.each([Role.RIDER, Role.DRIVER])("flags it for a %s", (role) => {
    expect(
      planCoopRangeNotice({
        role,
        coopStartDate: june,
        coopEndDate: march,
        alreadyShown: false,
      })?.message,
    ).toBe(REVERSED_COOP_RANGE_NOTICE);
  });

  it("stays quiet for a VIEWER, whose pickers are disabled (SCRUM-551)", () => {
    // The notice routes to the Account tab, where a VIEWER's pickers are
    // greyed out: an instruction they could not follow, on every load.
    expect(
      planCoopRangeNotice({
        role: Role.VIEWER,
        coopStartDate: june,
        coopEndDate: march,
        alreadyShown: false,
      }),
    ).toBeNull();
  });

  it("stays quiet for a forward range", () => {
    expect(
      planCoopRangeNotice({
        role: Role.RIDER,
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
        role: Role.RIDER,
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
        role: Role.RIDER,
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
        role: Role.RIDER,
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
        role: Role.RIDER,
        coopStartDate: june,
        coopEndDate: march,
        alreadyShown: true,
      }),
    ).toBeNull();
  });
});

/**
 * The year half (SCRUM-550). The same bar applies: this interrupts the profile
 * page, so a false positive is worse than the defect it reports, and most of
 * these cases are about staying quiet.
 */
describe("planCoopRangeNotice — implausible years", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  const plan = (
    start: Date | null,
    end: Date | null,
    role: Role = Role.RIDER,
  ) =>
    planCoopRangeNotice({
      role,
      coopStartDate: start,
      coopEndDate: end,
      alreadyShown: false,
      now,
    });

  it("flags production's commonest shape, and marks both dates", () => {
    expect(plan(day("1901-01-31"), day("1908-06-30"))).toEqual({
      tab: "account",
      fields: ["coopStartDate", "coopEndDate"],
      message: IMPLAUSIBLE_COOP_YEAR_NOTICE,
    });
  });

  it("flags a future year, marking only that date", () => {
    expect(plan(day("2026-01-31"), day("2073-06-30"))?.fields).toEqual([
      "coopEndDate",
    ]);
  });

  it("does not claim these users are invisible", () => {
    // The overlap filter defaults to "Any", so unlike a reversed range these
    // rows still appear by default. The toast must not say otherwise.
    expect(IMPLAUSIBLE_COOP_YEAR_NOTICE).not.toContain("not appearing");
  });

  it("raises one notice, not two, for a range both absurd and reversed", () => {
    // Production's 1913 → 1907 row trips both predicates. The year notice wins
    // because swapping the two would not fix it.
    expect(plan(day("1913-01-31"), day("1907-06-30"))).toEqual({
      tab: "account",
      fields: ["coopStartDate", "coopEndDate"],
      message: IMPLAUSIBLE_COOP_YEAR_NOTICE,
    });
  });

  it("leaves a plausible reversed range to the reversed notice", () => {
    expect(plan(day("2026-06-30"), day("2026-03-31"))?.message).toBe(
      REVERSED_COOP_RANGE_NOTICE,
    );
  });

  it.each([
    ["a current co-op", "2026-01-31", "2026-06-30"],
    ["a range on both edges", "2022-01-31", "2036-12-31"],
    ["a co-op that ended at the floor", "2022-01-31", "2022-06-30"],
    ["a one-month co-op", "2026-03-31", "2026-03-31"],
  ])("stays quiet for %s", (_name, start, end) => {
    expect(plan(day(start), day(end))).toBeNull();
  });

  it("stays quiet for a VIEWER, whose pickers are disabled", () => {
    // Routing them to a control they cannot change would be an instruction
    // they cannot follow.
    expect(plan(day("1901-01-31"), day("1906-06-30"), Role.VIEWER)).toBeNull();
  });

  it("stays quiet with only one date, when that date is plausible", () => {
    expect(plan(day("2026-01-31"), null)).toBeNull();
  });

  it("fires once, not on every refetch", () => {
    expect(
      planCoopRangeNotice({
        role: Role.RIDER,
        coopStartDate: day("1901-01-31"),
        coopEndDate: day("1908-06-30"),
        alreadyShown: true,
        now,
      }),
    ).toBeNull();
  });
});
