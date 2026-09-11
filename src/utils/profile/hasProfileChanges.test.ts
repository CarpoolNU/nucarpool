/**
 * The unsaved-changes rule.
 *
 * Two of its fourteen comparisons used `getDate()` — the day of the month — on
 * the co-op dates. The profile's month controls are antd `DatePicker`s storing
 * `date.toDate()`, which for a month selection is always **the first of that
 * month**, so the form's day-of-month was `1` whatever the user picked and
 * every month-to-month change compared equal. The page then navigated away
 * with no modal and the edit was gone.
 *
 * The dates below are shaped like the real ones rather than like the ticket's:
 * the ticket assumed `lastDayOfMonthUTC` wrote these fields and predicted that
 * only months sharing a last day would collide. It writes the map *filters*,
 * not the profile, so the defect was total rather than partial. `coopMonth`
 * models what actually reaches the form.
 *
 * The suite is built around **which** term fires rather than only whether one
 * did. `profileChanges` returns field names for that reason: a boolean cannot
 * tell "detected because the date changed" from "detected because some
 * unrelated term is always true", and it is exactly that kind of confusion
 * that let one wrong comparison sit among thirteen right ones.
 */

import { Permission, Role, Status } from "@prisma/client";
import type { OnboardingFormInputs, User } from "../types";
import { hasProfileChanges, profileChanges } from "./hasProfileChanges";

/**
 * A co-op month as the profile actually stores it: the **first** of the month.
 *
 * That is `dayjs("YYYY-MM").toDate()` from the antd month picker, and also what
 * Prisma reads back out of the `@db.Date` column. Jest pins `TZ=UTC`
 * (`jest.shared.config.js`), so local and UTC midnight coincide here and one
 * constructor covers both the written and the stored form.
 */
const coopMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month - 1, 1));

const STORED_START = coopMonth(2026, 1); // 2026-01-01
const STORED_END = coopMonth(2026, 6); // 2026-06-01
const STORED_START_TIME = new Date("2026-01-01T09:00:00.000Z");
const STORED_END_TIME = new Date("2026-01-01T17:00:00.000Z");

const user: User = {
  id: "user-id",
  name: "Stored Name",
  email: null,
  emailVerified: null,
  image: null,
  bio: "Stored bio",
  preferredName: "Stored",
  pronouns: "they/them",
  permission: Permission.USER,
  isOnboarded: true,
  licenseSigned: true,
  dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  dateModified: new Date("2026-01-01T00:00:00.000Z"),
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Stored Co",
  daysWorking: "1,1,1,1,1,0,0",
  startTime: STORED_START_TIME,
  endTime: STORED_END_TIME,
  coopStartDate: STORED_START,
  coopEndDate: STORED_END,
  carpoolId: null,
} as unknown as User;

/** The form as `reset(...)` populates it from the row above: no changes. */
const pristine: OnboardingFormInputs = {
  role: user.role,
  status: user.status,
  seatAvail: user.seatAvail,
  companyName: user.companyName,
  companyAddress: undefined,
  startAddress: undefined,
  preferredName: user.preferredName,
  pronouns: user.pronouns,
  daysWorking: [true, true, true, true, true, false, false],
  startTime: user.startTime,
  endTime: user.endTime,
  coopStartDate: user.coopStartDate,
  coopEndDate: user.coopEndDate,
  bio: user.bio,
};

const form = (
  overrides: Partial<OnboardingFormInputs> = {},
): OnboardingFormInputs => ({ ...pristine, ...overrides });

describe("profileChanges", () => {
  describe("the co-op dates", () => {
    /**
     * The regression. Every one of these compared equal under `getDate()`,
     * because both sides are the first of a month. The first three are the
     * pairs the ticket named; February is included precisely because it
     * expected it to be *detected* and it was not.
     */
    const COLLIDING = [
      {
        from: "January",
        to: "March",
        a: coopMonth(2026, 1),
        b: coopMonth(2026, 3),
      },
      {
        from: "July",
        to: "December",
        a: coopMonth(2026, 7),
        b: coopMonth(2026, 12),
      },
      {
        from: "April",
        to: "September",
        a: coopMonth(2026, 4),
        b: coopMonth(2026, 9),
      },
      {
        from: "January",
        to: "February",
        a: coopMonth(2026, 1),
        b: coopMonth(2026, 2),
      },
      {
        from: "June",
        to: "November",
        a: coopMonth(2026, 6),
        b: coopMonth(2026, 11),
      },
    ];

    it.each(COLLIDING)(
      "detects a start-date change from $from to $to",
      ({ a, b }) => {
        // Both are the first of a month, which is the collision itself.
        //
        // `getUTCDate`, not `getDate`. The dates are built in UTC, and
        // `test.yml` runs the whole suite a second time under
        // `NUCARPOOL_TEST_TZ=America/New_York` - where a local accessor reads
        // 2026-01-01Z as the 31st and 2026-03-01Z as the 28th, and this line
        // fails while the assertion it introduces still passes. A test about
        // the difference between a day-of-month and an instant has no business
        // depending on the reader's zone.
        expect(a.getUTCDate()).toBe(b.getUTCDate());
        expect(
          profileChanges(form({ coopStartDate: b }), {
            ...user,
            coopStartDate: a,
          }),
        ).toEqual(["coopStartDate"]);
      },
    );

    it.each(COLLIDING)(
      "detects an end-date change from $from to $to",
      ({ a, b }) => {
        expect(
          profileChanges(form({ coopEndDate: b }), { ...user, coopEndDate: a }),
        ).toEqual(["coopEndDate"]);
      },
    );

    it("detects a year-only change, where the day number is identical", () => {
      // January 2026 -> January 2027: same month, same day number, different
      // year. `getDate()` could never see this one either.
      expect(
        profileChanges(form({ coopStartDate: coopMonth(2027, 1) }), {
          ...user,
          coopStartDate: coopMonth(2026, 1),
        }),
      ).toEqual(["coopStartDate"]);
    });

    it("detects a change into February, which the ticket believed already worked", () => {
      expect(
        profileChanges(form({ coopStartDate: coopMonth(2026, 2) }), {
          ...user,
          coopStartDate: coopMonth(2026, 1),
        }),
      ).toEqual(["coopStartDate"]);
    });

    it("reports no change for the same month re-selected", () => {
      // A fresh `Date` object for the same instant: compared by value, not by
      // identity, so re-picking the current month is not an edit.
      expect(
        profileChanges(form({ coopStartDate: coopMonth(2026, 1) }), user),
      ).toEqual([]);
    });

    it("detects a date being cleared, and one being set", () => {
      expect(profileChanges(form({ coopStartDate: null }), user)).toEqual([
        "coopStartDate",
      ]);
      expect(
        profileChanges(form({ coopStartDate: coopMonth(2026, 3) }), {
          ...user,
          coopStartDate: null,
        }),
      ).toEqual(["coopStartDate"]);
    });

    it("reports no change when both sides have no date", () => {
      expect(
        profileChanges(form({ coopStartDate: null, coopEndDate: null }), {
          ...user,
          coopStartDate: null,
          coopEndDate: null,
        }),
      ).toEqual([]);
    });
  });

  describe("every other field still participates", () => {
    // One case per field: the fix is to one term, not a rewrite of the rule,
    // so each of the remaining twelve has to still be able to fire.
    const CASES: { field: string; changed: Partial<OnboardingFormInputs> }[] = [
      { field: "role", changed: { role: Role.RIDER } },
      { field: "seatAvail", changed: { seatAvail: 5 } },
      { field: "status", changed: { status: Status.INACTIVE } },
      { field: "companyName", changed: { companyName: "Other Co" } },
      { field: "companyAddress", changed: { companyAddress: "1 Main St" } },
      { field: "startAddress", changed: { startAddress: "2 Elm St" } },
      { field: "preferredName", changed: { preferredName: "Changed" } },
      { field: "pronouns", changed: { pronouns: "she/her" } },
      {
        field: "daysWorking",
        changed: { daysWorking: [true, true, true, true, true, true, false] },
      },
      {
        field: "startTime",
        changed: { startTime: new Date("2026-01-01T10:00:00.000Z") },
      },
      {
        field: "endTime",
        changed: { endTime: new Date("2026-01-01T18:00:00.000Z") },
      },
      { field: "bio", changed: { bio: "Changed bio" } },
    ];

    it.each(CASES)("detects a change to $field alone", ({ field, changed }) => {
      expect(profileChanges(form(changed), user)).toEqual([field]);
    });

    it("detects a start-time change that keeps the same calendar day", () => {
      // The counterpart of the co-op bug: `startTime` was always compared by
      // instant, and this is the assertion that says so.
      expect(
        profileChanges(
          form({ startTime: new Date("2026-01-01T23:00:00.000Z") }),
          user,
        ),
      ).toEqual(["startTime"]);
    });
  });

  describe("the no-change direction", () => {
    // If this regresses the modal becomes noise, and a modal nobody believes
    // is worse than no modal.
    it("reports nothing for a form matching the stored row", () => {
      expect(profileChanges(pristine, user)).toEqual([]);
    });

    it("reports nothing when the dates are equal but not the same object", () => {
      expect(
        profileChanges(
          form({
            coopStartDate: new Date(STORED_START.getTime()),
            coopEndDate: new Date(STORED_END.getTime()),
            startTime: new Date(STORED_START_TIME.getTime()),
            endTime: new Date(STORED_END_TIME.getTime()),
          }),
          user,
        ),
      ).toEqual([]);
    });
  });

  describe("several fields at once", () => {
    it("names each one, in the order the original chain listed them", () => {
      expect(
        profileChanges(
          form({
            bio: "Changed bio",
            coopStartDate: coopMonth(2026, 3),
            role: Role.RIDER,
          }),
          user,
        ),
      ).toEqual(["role", "coopStartDate", "bio"]);
    });
  });

  describe("edge cases carried over unchanged", () => {
    it("treats an unresolved user as everything having changed", () => {
      // `user` is null while the query is in flight. The original compared
      // through `user?.`, so the form's own values read as changes; preserved
      // rather than made quieter, because a modal is the safe direction.
      expect(profileChanges(pristine, null).length).toBeGreaterThan(0);
    });

    it("ignores stored working days beyond the form's array length", () => {
      // Documented, not fixed - this was confirmed and
      // recorded. The form always produces seven booleans, so an eighth stored
      // day is unreachable; widening the comparison would change what the
      // modal does for input the form cannot make.
      expect(
        profileChanges(form(), { ...user, daysWorking: "1,1,1,1,1,0,0,1" }),
      ).toEqual([]);
    });

    it("reports no day change when the form array is absent", () => {
      // Same note: `[].some(...)` is false whatever is stored.
      expect(profileChanges(form({ daysWorking: undefined }), user)).toEqual(
        [],
      );
    });
  });
});

describe("hasProfileChanges", () => {
  it("is false for a pristine form", () => {
    expect(hasProfileChanges(pristine, user)).toBe(false);
  });

  it("is true for the January to March change that used to slip through", () => {
    expect(
      hasProfileChanges(form({ coopStartDate: coopMonth(2026, 3) }), user),
    ).toBe(true);
  });

  it("agrees with profileChanges over a spread of inputs", () => {
    const inputs = [
      pristine,
      form({ bio: "x" }),
      form({ coopEndDate: coopMonth(2026, 9) }),
      form({ coopStartDate: null }),
    ];

    inputs.forEach((values) => {
      expect(hasProfileChanges(values, user)).toBe(
        profileChanges(values, user).length > 0,
      );
    });
  });
});
