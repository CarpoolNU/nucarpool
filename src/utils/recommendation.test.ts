import { Role } from "@prisma/client";
import { calculateScore, minutesApart } from "./recommendation";
import type { FInputs } from "./recommendation";
import {
  anyFilters,
  at,
  BOSTON,
  buildSearch,
  day,
  milesEastOf,
  milesNorth,
  milesNorthOf,
  ORIGIN,
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
        // SCRUM-348. The guard tested `=== 0`, so this row scored as available
        // and was offered — while `reserveSeat` refused every acceptance,
        // because it has always tested `> 0`.
        name: "a rider is not matched with a driver whose seat count went negative",
        currentRole: Role.RIDER,
        candidateRole: Role.DRIVER,
        candidateSeats: -1,
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

    it("reads 9:50 vs 10:00 as 10 minutes apart, not 110", () => {
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

  describe("distance measurement", () => {
    /**
     * Distance used to be `sqrt(dLat^2 + dLng^2) * 88`, which treats a degree of
     * longitude as covering the same ground as a degree of latitude. At Boston's
     * latitude a degree of longitude is only ~74% as wide, so east-west
     * separation read about a third too far and the mile filters did not mean
     * the same thing in every direction.
     */
    const atBoston = () => rider({ home: BOSTON, company: BOSTON });

    it("converts a degree of latitude to about 69 miles", () => {
      const oneDegreeNorth = driver({
        home: { lat: 1, lng: 0 },
        company: ORIGIN,
      });

      expect(
        score(
          rider({ home: ORIGIN, company: ORIGIN }),
          oneDegreeNorth,
          {},
          "distance",
        ),
      ).toBeCloseTo(69.09, 1);
    });

    it("scores a pair the same distance east and north identically", () => {
      const north = driver({
        home: milesNorthOf(BOSTON, 5),
        company: BOSTON,
      });
      const east = driver({ home: milesEastOf(BOSTON, 5), company: BOSTON });

      expect(score(atBoston(), north)).toBeCloseTo(score(atBoston(), east)!, 5);
    });

    it("applies a 6 mile filter the same east-west as north-south", () => {
      const within = { startDistance: 6 };

      for (const displace of [milesNorthOf, milesEastOf]) {
        expect(
          isMatch(
            atBoston(),
            driver({ home: displace(BOSTON, 5), company: BOSTON }),
            within,
          ),
        ).toBe(true);
        expect(
          isMatch(
            atBoston(),
            driver({ home: displace(BOSTON, 7), company: BOSTON }),
            within,
          ),
        ).toBe(false);
      }
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

      expect(homeApart).toBeCloseTo(0.1);
      expect(companyApart).toBeCloseTo(0.2);
      expect(companyApart).toBeCloseTo(homeApart! * 2);
    });

    it("saturates the distance penalty at the 6 mile cutoff", () => {
      // Distance used to be added twice, once without a ceiling, so the penalty
      // kept climbing and a distant pair could outweigh every other factor.
      expect(score(rider(), driver({ home: milesNorth(3) }))).toBeCloseTo(0.1);
      expect(score(rider(), driver({ home: milesNorth(6) }))).toBeCloseTo(0.2);
      expect(score(rider(), driver({ home: milesNorth(12) }))).toBeCloseTo(0.2);
    });

    it("never exceeds 1, the sum of the weights", () => {
      const worst = score(
        rider(),
        driver({
          home: milesNorth(50),
          company: milesNorth(50),
          startTime: at(20),
          endTime: at(23),
          daysWorking: "0,0,0,0,0,0,0",
          coopStart: day(2030, 1, 1),
          coopEnd: day(2030, 6, 1),
        }),
      );

      expect(worst).toBeLessThanOrEqual(1);
      expect(worst).toBeCloseTo(1);
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

      // 0.1 home distance + 0.06 days (1 - 2/5) + 0.05 partial overlap
      expect(score(rider(), candidate)).toBeCloseTo(0.21);
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

    it("ranks an unrecorded schedule worst when sorting by time", () => {
      // Lower is better, so leaving this at 0 made a candidate with no schedule
      // the top result of a sort that is entirely about schedule.
      const unknown = score(
        rider(),
        driver({ startTime: null, endTime: null }),
        {},
        "time",
      );
      const knownButClashing = score(
        rider(),
        driver({ startTime: at(13), endTime: at(21) }),
        {},
        "time",
      );

      expect(unknown).toBe(2);
      expect(unknown!).toBeGreaterThanOrEqual(knownButClashing!);
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

    it("stays finite when the filter records no working days", () => {
      // `daysWorking: ""` is the initial filter state on the map page and is
      // never replaced for VIEWER accounts. `1 - 0/0` used to leak NaN into
      // every score, and NaN comparisons made the whole sort arbitrary.
      const identical = score(rider(), driver(), { daysWorking: "" });
      const distant = score(rider(), driver({ home: milesNorth(3) }), {
        daysWorking: "",
      });

      expect(identical).toBe(0);
      expect(Number.isFinite(distant)).toBe(true);
      expect(identical!).toBeLessThan(distant!);
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
      ).toBeCloseTo(0.1);
    });
  });
});

/**
 * `minutesApart` reads the stored clock and takes the short way round it.
 *
 * Two defects, both invisible to the suite as it stood:
 *
 *  1. `getHours()`/`getMinutes()` reinterpreted a `@db.Time(0)` value - which
 *     Prisma returns as `1970-01-01T<time>Z` - in the *host's* zone. Amplify and
 *     GitHub Actions run UTC, local development runs `America/New_York`, so the
 *     matching results a developer saw were not the ones production computed.
 *  2. The difference was linear on minute offsets, so a pair straddling
 *     midnight was reported as the long way round: 23:30 and 00:30 came out as
 *     1380 minutes rather than 60, past every cutoff the UI offers.
 *
 * The old comment claimed a shared timezone offset always cancels in the
 * subtraction. It cancels only while both operands stay on the same side of a
 * day boundary under the shift, which is precisely the case (1) makes
 * host-dependent and (2) gets wrong.
 *
 * **How the timezone half is actually covered.** Not by looping over zones
 * inside a test: assigning `process.env.TZ` once a Jest worker is running has no
 * effect, because V8 caches the zone per isolate and the worker never
 * invalidates it. Such a loop reads the pinned zone for every iteration and
 * passes against any implementation, which is worse than no test. Instead:
 *
 *  - `jest.config.js` pins `TZ` in the parent process, before the workers fork.
 *  - `test.yml` runs the whole suite twice, under `UTC` and `America/New_York`,
 *    via `NUCARPOOL_TEST_TZ`. That is the real multi-zone run.
 *  - `runs under the zone that was requested of it` below fails if a requested
 *    zone did not take effect, so a leg cannot measure UTC while claiming a
 *    different zone. It cannot catch the variable going missing entirely.
 *  - `never reads a local-time accessor` closes the door structurally, in a
 *    single run: the host's zone cannot reach a result that never consults it.
 */
describe("minutesApart", () => {
  /** A schedule time exactly as Prisma returns one for a `@db.Time(0)`. */
  const stored = (clock: string) => new Date(`1970-01-01T${clock}:00Z`);

  it("measures a pair straddling midnight as the short way round", () => {
    // The ticket's failure scenario: 7:30pm and 8:30pm EDT, stored as 23:30
    // and 00:30 UTC. Linear subtraction of minute offsets gives 1380.
    expect(minutesApart(stored("23:30"), stored("00:30"))).toBe(60);
    expect(minutesApart(stored("00:30"), stored("23:30"))).toBe(60);
  });

  it("measures the ordinary daytime pair the same as before", () => {
    expect(minutesApart(stored("09:00"), stored("10:00"))).toBe(60);
    expect(minutesApart(stored("09:50"), stored("10:00"))).toBe(10);
    expect(minutesApart(stored("09:00"), stored("09:00"))).toBe(0);
  });

  it("never reports more than twelve hours, because a clock is circular", () => {
    // 720 is the antipode; past it the short way starts shrinking again.
    expect(minutesApart(stored("00:00"), stored("12:00"))).toBe(720);
    expect(minutesApart(stored("00:00"), stored("13:00"))).toBe(660);
    expect(minutesApart(stored("00:00"), stored("23:59"))).toBe(1);
  });

  it("reads the value that was stored, whatever the host would render it as", () => {
    // 23:30 UTC is 19:30 in New York and 08:30 the next morning in Tokyo. Under
    // the old accessors each zone produced a different pair of minute offsets;
    // the stored reading is the only one that is the same everywhere.
    expect(minutesApart(stored("23:30"), stored("00:30"))).toBe(60);
    expect(minutesApart(stored("19:30"), stored("20:30"))).toBe(60);
    expect(minutesApart(stored("08:30"), stored("09:30"))).toBe(60);
  });

  it("never reads a local-time accessor, so the host's zone cannot reach the result", () => {
    // The structural guard, and the one that holds in a single run: these three
    // methods are the only route from the host's zone into a `Date` reading, and
    // the old implementation used two of them.
    const localAccessors = [
      "getHours",
      "getMinutes",
      "getTimezoneOffset",
    ] as const;

    const a = stored("23:30");
    const b = stored("00:30");
    const spies = localAccessors.map((name) =>
      jest.spyOn(Date.prototype, name),
    );

    try {
      minutesApart(a, b);

      // Reported as an object so a failure names the offending accessor rather
      // than just showing `1` where `0` was expected.
      expect(
        localAccessors.map((name, index) => ({
          accessor: name,
          calls: spies[index]!.mock.calls.length,
        })),
      ).toEqual(localAccessors.map((name) => ({ accessor: name, calls: 0 })));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("runs under the zone that was requested of it", () => {
    // `test.yml` runs the suite under two zones, and this checks the request
    // took effect: `NUCARPOOL_TEST_TZ` set but not reaching `Date` would
    // otherwise leave the second leg measuring UTC while claiming otherwise.
    //
    // It cannot catch the variable going *missing* - requested and effective
    // would both collapse to UTC and this would pass - so the second leg
    // existing at all is guaranteed by `test.yml` and its review, not from
    // here. `never reads a local-time accessor` above is the assertion that
    // does not depend on either.
    //
    // Compared by **offset**, not by zone name. Many IANA zones are aliases and
    // ICU reports the canonical name rather than the one asked for, so
    // `Asia/Kolkata` resolves to `Asia/Calcutta` and a name comparison fails on
    // a zone that was in fact applied correctly. The offset is what the code
    // under test is actually sensitive to.
    const requested = process.env.NUCARPOOL_TEST_TZ || "UTC";

    expect(process.env.TZ).toBe(requested);

    const offsetOf = (timeZone: string) => {
      // A fixed instant, so this does not drift with the date the suite runs on.
      const instant = new Date("2026-01-15T12:00:00.000Z");
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(instant);
      const at = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value);
      return at("hour") * 60 + at("minute");
    };

    expect(offsetOf(Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
      offsetOf(requested),
    );
  });

  it("agrees with the shortest distance round the clock, across the whole day", () => {
    // An independent derivation of the same idea - the nearest of the
    // candidate's three positions on the timeline - rather than a restatement
    // of `min(d, 1440 - d)`. Swept over every half hour against every other.
    const MINUTES_PER_DAY = 24 * 60;
    const clocks = Array.from({ length: 48 }, (_, index) => {
      const hour = String(Math.floor(index / 2)).padStart(2, "0");
      return `${hour}:${index % 2 === 0 ? "00" : "30"}`;
    });
    const minutesOf = (clock: string) => {
      const [hour, minute] = clock.split(":").map(Number);
      return hour! * 60 + minute!;
    };

    for (const a of clocks) {
      for (const b of clocks) {
        const shortest = Math.min(
          Math.abs(minutesOf(a) - minutesOf(b)),
          Math.abs(minutesOf(a) - (minutesOf(b) + MINUTES_PER_DAY)),
          Math.abs(minutesOf(a) - (minutesOf(b) - MINUTES_PER_DAY)),
        );

        expect({ a, b, minutes: minutesApart(stored(a), stored(b)) }).toEqual({
          a,
          b,
          minutes: shortest,
        });
      }
    }
  });

  it("is symmetric, and zero only for the same clock time", () => {
    const clocks = ["00:00", "06:15", "12:00", "18:45", "23:59"];

    for (const a of clocks) {
      expect(minutesApart(stored(a), stored(a))).toBe(0);

      for (const b of clocks) {
        expect(minutesApart(stored(a), stored(b))).toBe(
          minutesApart(stored(b), stored(a)),
        );
      }
    }
  });

  it("ignores the date component, which a Time column does not carry", () => {
    // `at()` builds its fixtures on 2024-01-01 and Prisma returns 1970-01-01;
    // only the clock may matter, or the two would not be interchangeable.
    expect(
      minutesApart(new Date("2024-06-01T09:00:00Z"), stored("10:00")),
    ).toBe(60);
  });
});

describe("time filtering across midnight", () => {
  /**
   * The evening pair from the ticket, expressed the way the scorer receives it.
   * `at` builds UTC instants, so these are 23:30 and 00:30 stored - 7:30pm and
   * 8:30pm in Boston.
   */
  const eveningRider = () =>
    rider({ startTime: at(11, 30), endTime: at(23, 30) });
  const eveningDriver = () =>
    driver({ startTime: at(12, 30), endTime: at(0, 30) });

  it("keeps a pair finishing 60 minutes apart either side of midnight", () => {
    // The `endTime` filter admits up to 4 hours. Production computed 1380
    // minutes for this pair and dropped it from both sets of results.
    expect(isMatch(eveningRider(), eveningDriver(), { endTime: 1 })).toBe(true);
    expect(isMatch(eveningRider(), eveningDriver(), { endTime: 4 })).toBe(true);
  });

  it("still applies the cutoff to such a pair rather than waving it through", () => {
    // 60 minutes really is measured, not merely made small enough to pass: a
    // cutoff below it still excludes.
    expect(isMatch(eveningRider(), eveningDriver(), { endTime: 59 / 60 })).toBe(
      false,
    );
  });

  it("scores the midnight-straddling gap as 60 minutes, not a saturated one", () => {
    // 60/80 of the end-time weight. Under the old arithmetic the component
    // saturated at 1.0, so the pair was also ranked as badly as possible.
    const current = rider({ startTime: at(9), endTime: at(23, 30) });
    const candidate = driver({ startTime: at(9), endTime: at(0, 30) });

    expect(score(current, candidate)).toBeCloseTo((60 / 80) * 0.1);
  });

  it("ranks the same pair on the time sort as any other 60 minute gap", () => {
    const straddling = score(
      rider({ startTime: at(23, 30), endTime: at(17) }),
      driver({ startTime: at(0, 30), endTime: at(17) }),
      {},
      "time",
    );
    const daytime = score(
      rider({ startTime: at(9, 0), endTime: at(17) }),
      driver({ startTime: at(10, 0), endTime: at(17) }),
      {},
      "time",
    );

    expect(straddling).toBeCloseTo(daytime!);
  });
});
