import { Role } from "@prisma/client";
import { calculateScore } from "./recommendation";
import type { FInputs } from "./recommendation";
import {
  anyFilters,
  at,
  buildSearch,
  day,
  milesNorth,
  SearchFixture,
  TERM_END,
  TERM_START,
  WEEKDAYS,
} from "./recommendation.fixtures";

/**
 * Scores `candidate` relative to `current`. `undefined` is how `calculateScore`
 * signals "filtered out", so these tests distinguish that from a score of 0.
 */
const score = (
  current: SearchFixture,
  candidate: SearchFixture,
  filters: Partial<FInputs> = {},
  sort = "any",
): number | undefined =>
  calculateScore(current, anyFilters(filters), sort)(candidate)?.score;

const isMatch = (
  current: SearchFixture,
  candidate: SearchFixture,
  filters: Partial<FInputs> = {},
  sort = "any",
): boolean => score(current, candidate, filters, sort) !== undefined;

/** The user doing the searching: a rider sitting on the origin, 9-to-5 weekdays. */
const rider = (options = {}) =>
  buildSearch({ id: "current", role: Role.RIDER, seatsAvail: 0, ...options });

/**
 * The candidate: a driver with seats, identical to `rider()` in every scoreable
 * dimension, which makes its score the perfect-match baseline of 0.
 */
const driver = (options = {}) =>
  buildSearch({
    id: "candidate",
    role: Role.DRIVER,
    seatsAvail: 4,
    ...options,
  });

describe("calculateScore", () => {
  describe("role and group compatibility", () => {
    const cases: Array<{
      name: string;
      currentRole: Role;
      candidateRole: Role;
      candidateSeats: number;
      matches: boolean;
    }> = [
      {
        name: "a rider is not matched with another rider",
        currentRole: Role.RIDER,
        candidateRole: Role.RIDER,
        candidateSeats: 4,
        matches: false,
      },
      {
        name: "a rider is not matched with a driver who has no seats left",
        currentRole: Role.RIDER,
        candidateRole: Role.DRIVER,
        candidateSeats: 0,
        matches: false,
      },
      {
        name: "a rider is matched with a driver who has at least one seat",
        currentRole: Role.RIDER,
        candidateRole: Role.DRIVER,
        candidateSeats: 1,
        matches: true,
      },
      {
        name: "a driver is not matched with another driver",
        currentRole: Role.DRIVER,
        candidateRole: Role.DRIVER,
        candidateSeats: 4,
        matches: false,
      },
      {
        name: "a driver is matched with a rider regardless of the rider's seat count",
        currentRole: Role.DRIVER,
        candidateRole: Role.RIDER,
        candidateSeats: 0,
        matches: true,
      },
      {
        name: "a viewer is matched with drivers",
        currentRole: Role.VIEWER,
        candidateRole: Role.DRIVER,
        candidateSeats: 4,
        matches: true,
      },
      {
        name: "a viewer is matched with riders",
        currentRole: Role.VIEWER,
        candidateRole: Role.RIDER,
        candidateSeats: 0,
        matches: true,
      },
      {
        name: "viewers are never offered as candidates to a rider",
        currentRole: Role.RIDER,
        candidateRole: Role.VIEWER,
        candidateSeats: 4,
        matches: false,
      },
      {
        name: "viewers are never offered as candidates to a driver",
        currentRole: Role.DRIVER,
        candidateRole: Role.VIEWER,
        candidateSeats: 4,
        matches: false,
      },
    ];

    it.each(cases)(
      "$name",
      ({ currentRole, candidateRole, candidateSeats, matches }) => {
        const current = buildSearch({ id: "current", role: currentRole });
        const candidate = buildSearch({
          id: "candidate",
          role: candidateRole,
          seatsAvail: candidateSeats,
        });

        expect(isMatch(current, candidate)).toBe(matches);
      },
    );

    it("excludes a candidate already in the current user's carpool group", () => {
      expect(
        score(
          rider({ carpoolId: "group-1" }),
          driver({ carpoolId: "group-1" }),
        ),
      ).toBeUndefined();
    });

    it("includes a candidate who belongs to a different carpool group", () => {
      expect(
        score(
          rider({ carpoolId: "group-1" }),
          driver({ carpoolId: "group-2" }),
        ),
      ).toBeCloseTo(0);
    });

    it("does not treat two users without a group as sharing one", () => {
      expect(
        score(rider({ carpoolId: null }), driver({ carpoolId: null })),
      ).toBeCloseTo(0);
    });
  });

  describe("distance cutoffs", () => {
    const distanceCases: Array<{
      miles: number;
      cutoff: number;
      matches: boolean;
    }> = [
      { miles: 5.9, cutoff: 6, matches: true },
      // The comparison is strictly greater-than, so the cutoff itself is a match.
      { miles: 6, cutoff: 6, matches: true },
      { miles: 6.1, cutoff: 6, matches: false },
      { miles: 19, cutoff: 19, matches: true },
      { miles: 19.5, cutoff: 19, matches: false },
      // 20 is the "any distance" sentinel: the filter stops applying entirely.
      { miles: 100, cutoff: 20, matches: true },
    ];

    it.each(distanceCases)(
      "homes $miles miles apart against a $cutoff mile cutoff matches=$matches",
      ({ miles, cutoff, matches }) => {
        expect(
          isMatch(rider(), driver({ home: milesNorth(miles) }), {
            startDistance: cutoff,
          }),
        ).toBe(matches);
      },
    );

    it.each(distanceCases)(
      "companies $miles miles apart against a $cutoff mile cutoff matches=$matches",
      ({ miles, cutoff, matches }) => {
        expect(
          isMatch(rider(), driver({ company: milesNorth(miles) }), {
            endDistance: cutoff,
          }),
        ).toBe(matches);
      },
    );

    it("applies the home and company cutoffs independently", () => {
      const candidate = driver({
        home: milesNorth(2),
        company: milesNorth(10),
      });

      expect(
        isMatch(rider(), candidate, { startDistance: 5, endDistance: 20 }),
      ).toBe(true);
      expect(
        isMatch(rider(), candidate, { startDistance: 20, endDistance: 5 }),
      ).toBe(false);
    });

    it("treats a missing Location relation as the origin rather than excluding the user", () => {
      expect(
        score(rider(), driver({ home: null, company: null }), {
          startDistance: 1,
          endDistance: 1,
        }),
      ).toBeCloseTo(0);
    });
  });

  describe("time compatibility", () => {
    it("keeps a candidate whose difference is exactly the cutoff", () => {
      // The cutoff is expressed in hours; 9:00 against 10:00 is 60 minutes.
      expect(
        isMatch(rider(), driver({ startTime: at(10), endTime: at(17) }), {
          startTime: 1,
        }),
      ).toBe(true);
    });

    it("drops a candidate one minute past the cutoff", () => {
      expect(
        isMatch(rider(), driver({ startTime: at(10, 1), endTime: at(17) }), {
          startTime: 1,
        }),
      ).toBe(false);
    });

    it("stops filtering on time at the 'any' sentinel of 4 hours", () => {
      expect(
        isMatch(rider(), driver({ startTime: at(23), endTime: at(3) }), {
          startTime: 4,
          endTime: 4,
        }),
      ).toBe(true);
    });

    it("applies the start and end time cutoffs independently", () => {
      const candidate = driver({ startTime: at(9), endTime: at(20) });

      expect(isMatch(rider(), candidate, { startTime: 1, endTime: 4 })).toBe(
        true,
      );
      expect(isMatch(rider(), candidate, { startTime: 4, endTime: 1 })).toBe(
        false,
      );
    });

    it("skips time filtering entirely when either user has no schedule recorded", () => {
      // A zero-hour cutoff would exclude everyone if times were compared at all.
      expect(
        isMatch(rider(), driver({ startTime: null, endTime: null }), {
          startTime: 0,
          endTime: 0,
        }),
      ).toBe(true);
    });

    it("reads 9:50 vs 10:00 as 10 minutes apart, not 110 (SCRUM-235)", () => {
      const current = rider({ startTime: at(9, 50), endTime: at(17) });
      const candidate = driver({ startTime: at(10, 0), endTime: at(17) });

      // The pair is 10 minutes apart, so it clears every cutoff the UI offers,
      // down to the tightest. The previous implementation computed
      // |9-10| * 60 + |50-0| = 110 minutes and rejected this at a 1 hour cutoff.
      expect(isMatch(current, candidate, { startTime: 1 })).toBe(true);
      expect(isMatch(current, candidate, { startTime: 0.25 })).toBe(true);
    });

    it.each([
      {
        label: "minutes running backwards across the hour",
        currentStart: at(9, 50),
        candidateStart: at(10, 0),
        minutes: 10,
      },
      {
        label: "minutes running forwards across the hour",
        currentStart: at(8, 45),
        candidateStart: at(9, 15),
        minutes: 30,
      },
      {
        label: "a whole hour on the same minute",
        currentStart: at(9, 0),
        candidateStart: at(10, 0),
        minutes: 60,
      },
      {
        label: "the same time",
        currentStart: at(9, 0),
        candidateStart: at(9, 0),
        minutes: 0,
      },
      {
        label: "minutes only, within one hour",
        currentStart: at(9, 15),
        candidateStart: at(9, 45),
        minutes: 30,
      },
      {
        label: "a candidate earlier than the current user",
        currentStart: at(10, 0),
        candidateStart: at(9, 50),
        minutes: 10,
      },
    ])(
      "measures $label as $minutes minutes, at the filter boundary",
      ({ currentStart, candidateStart, minutes }) => {
        const current = rider({ startTime: currentStart, endTime: at(17) });
        const candidate = driver({
          startTime: candidateStart,
          endTime: at(17),
        });

        // The filter excludes when the difference is strictly greater than the
        // cutoff, so a cutoff of exactly the true gap keeps the pair and one
        // minute below it drops them. That brackets the value from both sides.
        expect(isMatch(current, candidate, { startTime: minutes / 60 })).toBe(
          true,
        );

        if (minutes > 0) {
          expect(
            isMatch(current, candidate, { startTime: (minutes - 1) / 60 }),
          ).toBe(false);
        }
      },
    );

    it("applies the same measurement to the end time", () => {
      // The end time runs through the same helper; this guards against the fix
      // being applied to only one of the two.
      const current = rider({ startTime: at(9), endTime: at(16, 50) });
      const candidate = driver({ startTime: at(9), endTime: at(17, 0) });

      expect(isMatch(current, candidate, { endTime: 10 / 60 })).toBe(true);
      expect(isMatch(current, candidate, { endTime: 9 / 60 })).toBe(false);
    });

    it("scores a 10 minute gap far better than the old arithmetic did", () => {
      // Scoring reads the same value as the filter, so the correction has to
      // show up in the score too: 10/80 of the start-time weight, not 80/80.
      const current = rider({ startTime: at(9, 50), endTime: at(17) });
      const candidate = driver({ startTime: at(10, 0), endTime: at(17) });

      expect(score(current, candidate)).toBeCloseTo((10 / 80) * 0.1);
    });
  });

  describe("overlapping days", () => {
    const MON_TUE = "0,1,1,0,0,0,0";
    const MON_TO_THU = "0,1,1,1,1,0,0";

    it("requires every one of the current user's days when days=1", () => {
      expect(
        isMatch(rider(), driver({ daysWorking: MON_TO_THU }), {
          days: 1,
          daysWorking: WEEKDAYS,
        }),
      ).toBe(false);
      expect(
        isMatch(rider(), driver({ daysWorking: WEEKDAYS }), {
          days: 1,
          daysWorking: WEEKDAYS,
        }),
      ).toBe(true);
    });

    it("ignores candidate days the current user does not work when days=1", () => {
      // The candidate also works Saturday; that is spare capacity, not a mismatch.
      expect(
        isMatch(rider(), driver({ daysWorking: "0,1,1,1,1,1,1" }), {
          days: 1,
          daysWorking: WEEKDAYS,
        }),
      ).toBe(true);
    });

    it.each([
      { flexDays: 1, matches: true },
      { flexDays: 2, matches: true },
      { flexDays: 3, matches: false },
    ])(
      "days=2 with flexDays=$flexDays and 2 shared days matches=$matches",
      ({ flexDays, matches }) => {
        expect(
          isMatch(rider(), driver({ daysWorking: MON_TUE }), {
            days: 2,
            flexDays,
            daysWorking: WEEKDAYS,
          }),
        ).toBe(matches);
      },
    );

    it("does not filter on days at all when days=0", () => {
      expect(
        isMatch(rider(), driver({ daysWorking: "0,0,0,0,0,0,1" }), {
          days: 0,
          daysWorking: WEEKDAYS,
        }),
      ).toBe(true);
    });

    it("scores fewer shared days worse than more shared days", () => {
      const twoShared = score(rider(), driver({ daysWorking: MON_TUE }));
      const fourShared = score(rider(), driver({ daysWorking: MON_TO_THU }));
      const allShared = score(rider(), driver({ daysWorking: WEEKDAYS }));

      expect(allShared).toBeLessThan(fourShared!);
      expect(fourShared).toBeLessThan(twoShared!);
    });

    it("uses the filter's daysWorking rather than the current user's stored days", () => {
      // The searcher's profile says weekdays, but the filter narrows to Mon/Tue,
      // which makes a Mon/Tue-only candidate an exact match.
      expect(
        isMatch(
          rider({ daysWorking: WEEKDAYS }),
          driver({ daysWorking: MON_TUE }),
          {
            days: 1,
            daysWorking: MON_TUE,
          },
        ),
      ).toBe(true);
    });
  });

  describe("date range overlap", () => {
    it.each([
      {
        name: "identical ranges",
        coopStart: TERM_START,
        coopEnd: TERM_END,
        partial: true,
        full: true,
      },
      {
        name: "candidate range strictly contains the filter range",
        coopStart: day(2023, 12, 1),
        coopEnd: day(2024, 7, 1),
        partial: true,
        full: true,
      },
      {
        name: "candidate starts mid-term and runs past the end",
        coopStart: day(2024, 3, 1),
        coopEnd: day(2024, 9, 1),
        partial: true,
        full: false,
      },
      {
        name: "candidate sits entirely inside the filter range",
        coopStart: day(2024, 2, 1),
        coopEnd: day(2024, 3, 1),
        partial: true,
        full: false,
      },
      {
        name: "candidate ends exactly on the filter start date",
        coopStart: day(2023, 9, 1),
        coopEnd: TERM_START,
        partial: true,
        full: false,
      },
      {
        name: "candidate finishes before the filter range begins",
        coopStart: day(2023, 9, 1),
        coopEnd: day(2023, 12, 31),
        partial: false,
        full: false,
      },
      {
        name: "candidate begins after the filter range ends",
        coopStart: day(2024, 7, 1),
        coopEnd: day(2024, 9, 1),
        partial: false,
        full: false,
      },
    ])(
      "$name: partial=$partial full=$full",
      ({ coopStart, coopEnd, partial, full }) => {
        const candidate = driver({ coopStart, coopEnd });

        expect(isMatch(rider(), candidate, { dateOverlap: 1 })).toBe(partial);
        expect(isMatch(rider(), candidate, { dateOverlap: 2 })).toBe(full);
        // dateOverlap=0 never filters, whatever the ranges look like.
        expect(isMatch(rider(), candidate, { dateOverlap: 0 })).toBe(true);
      },
    );

    it("scores full overlap best, then partial, then none", () => {
      const full = score(
        rider(),
        driver({ coopStart: TERM_START, coopEnd: TERM_END }),
      );
      const partial = score(
        rider(),
        driver({ coopStart: day(2024, 3, 1), coopEnd: day(2024, 9, 1) }),
      );
      const none = score(
        rider(),
        driver({ coopStart: day(2024, 7, 1), coopEnd: day(2024, 9, 1) }),
      );

      expect(full).toBeCloseTo(0);
      expect(partial).toBeCloseTo(0.05);
      expect(none).toBeCloseTo(0.1);
    });

    it("excludes candidates with no co-op dates whenever a date filter is active", () => {
      const candidate = driver({ coopStart: null, coopEnd: null });

      expect(isMatch(rider(), candidate, { dateOverlap: 1 })).toBe(false);
      expect(isMatch(rider(), candidate, { dateOverlap: 2 })).toBe(false);
    });

    it("keeps candidates with no co-op dates when no date filter is active, at the worst date score", () => {
      expect(
        score(rider(), driver({ coopStart: null, coopEnd: null }), {
          dateOverlap: 0,
        }),
      ).toBeCloseTo(0.1);
    });
  });

  describe("score weighting under the 'any' sort", () => {
    it("gives an identical, co-located candidate a perfect score of 0", () => {
      expect(score(rider(), driver())).toBeCloseTo(0);
    });

    it("penalises a candidate with no recorded schedule by the full time weight", () => {
      // weights.startTime + weights.endTime
      expect(
        score(rider(), driver({ startTime: null, endTime: null })),
      ).toBeCloseTo(0.2);
    });

    it("weights company distance twice as heavily as home distance", () => {
      const homeApart = score(rider(), driver({ home: milesNorth(3) }));
      const companyApart = score(rider(), driver({ company: milesNorth(3) }));

      expect(homeApart).toBeCloseTo(0.2);
      expect(companyApart).toBeCloseTo(0.4);
      expect(companyApart).toBeCloseTo(homeApart! * 2);
    });

    it("keeps growing the distance penalty past the 6 mile scoring cutoff (SCRUM-236)", () => {
      // Only one of the two distance terms is clamped at the cutoff, so the total
      // keeps rising instead of saturating.
      expect(score(rider(), driver({ home: milesNorth(3) }))).toBeCloseTo(0.2);
      expect(score(rider(), driver({ home: milesNorth(6) }))).toBeCloseTo(0.4);
      expect(score(rider(), driver({ home: milesNorth(12) }))).toBeCloseTo(0.6);
    });

    it("scores a one hour schedule difference at three quarters of the time weight", () => {
      // 60 minutes / 80 minute cutoff * weights.startTime
      expect(
        score(rider(), driver({ startTime: at(10), endTime: at(17) })),
      ).toBeCloseTo(0.075);
    });

    it("caps the time component once the difference passes the 80 minute cutoff", () => {
      expect(
        score(rider(), driver({ startTime: at(11), endTime: at(17) })),
      ).toBeCloseTo(0.1);
      expect(
        score(rider(), driver({ startTime: at(12), endTime: at(17) })),
      ).toBeCloseTo(0.1);
    });

    it("adds the day, date and distance penalties together", () => {
      const candidate = driver({
        home: milesNorth(3),
        daysWorking: "0,1,1,0,0,0,0",
        coopStart: day(2024, 3, 1),
        coopEnd: day(2024, 9, 1),
      });

      // 0.2 home distance + 0.12 days (1 - 2/5, counted twice) + 0.05 partial overlap
      expect(score(rider(), candidate)).toBeCloseTo(0.37);
    });

    it("ranks a closer, better aligned candidate ahead of a worse one", () => {
      const near = score(rider(), driver({ id: "near", home: milesNorth(1) }));
      const far = score(rider(), driver({ id: "far", home: milesNorth(5) }));

      expect(near).toBeLessThan(far!);
    });
  });

  describe("sort modes", () => {
    it("returns raw combined mileage when sorting by distance", () => {
      const candidate = driver({ home: milesNorth(3), company: milesNorth(4) });

      expect(score(rider(), candidate, {}, "distance")).toBeCloseTo(7);
    });

    it("returns only the normalised time components when sorting by time", () => {
      // 60/80 for the start time, 0 for the identical end time.
      expect(
        score(
          rider(),
          driver({ startTime: at(10), endTime: at(17) }),
          {},
          "time",
        ),
      ).toBeCloseTo(0.75);
    });

    it("scores every candidate 0 when sorting by time without recorded schedules (SCRUM-236)", () => {
      expect(
        score(rider(), driver({ startTime: null, endTime: null }), {}, "time"),
      ).toBe(0);
    });

    it("scores every candidate 0 for an unrecognised sort key", () => {
      expect(
        score(rider(), driver({ home: milesNorth(5) }), {}, "nonsense"),
      ).toBe(0);
    });

    it("still applies exclusions regardless of the sort mode", () => {
      const anotherRider = buildSearch({ id: "other", role: Role.RIDER });

      for (const sort of ["any", "distance", "time", "nonsense"]) {
        expect(score(rider(), anotherRider, {}, sort)).toBeUndefined();
      }
    });
  });

  describe("identity and pathological inputs", () => {
    it("reports the candidate's user id, not the search row id", () => {
      const result = calculateScore(
        rider(),
        anyFilters(),
        "any",
      )(driver({ id: "user-42" }));

      expect(result?.id).toBe("user-42");
    });

    it("produces NaN scores when the filter records no working days (SCRUM-236)", () => {
      // `daysWorking: ""` is the initial filter state on the map page and is never
      // replaced for VIEWER accounts, so 1 - 0/0 leaks NaN into the ranking.
      expect(score(rider(), driver(), { daysWorking: "" })).toBeNaN();
    });

    it("excludes nobody on the day filter when the filter records no days", () => {
      expect(isMatch(rider(), driver(), { days: 1, daysWorking: "" })).toBe(
        true,
      );
    });

    it("treats a truncated daysWorking string as working none of the missing days", () => {
      const candidate = driver({ daysWorking: "0,1" });

      expect(
        isMatch(rider(), candidate, { days: 1, daysWorking: WEEKDAYS }),
      ).toBe(false);
      expect(
        isMatch(rider(), candidate, {
          days: 2,
          flexDays: 1,
          daysWorking: WEEKDAYS,
        }),
      ).toBe(true);
    });

    it("evaluates each candidate independently from a single scorer", () => {
      const scorer = calculateScore(rider(), anyFilters(), "any");

      expect(scorer(driver({ id: "a" }))?.score).toBeCloseTo(0);
      expect(
        scorer(buildSearch({ id: "b", role: Role.RIDER })),
      ).toBeUndefined();
      expect(
        scorer(driver({ id: "c", home: milesNorth(3) }))?.score,
      ).toBeCloseTo(0.2);
    });
  });
});
