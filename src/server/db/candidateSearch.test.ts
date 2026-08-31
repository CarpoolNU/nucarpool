import { Role, Status } from "@prisma/client";
import {
  boundingBox,
  buildCandidateWhere,
  rankCandidates,
  CANDIDATE_LIMIT,
} from "./candidateSearch";
import type { CurrentSearch } from "./candidateSearch";
import {
  calculateScore,
  MILES_PER_DEGREE_LATITUDE,
  milesBetween,
} from "../../utils/recommendation";
import type { FInputs } from "../../utils/recommendation";
import {
  anyFilters,
  BOSTON,
  buildSearch,
  day,
  milesEastOf,
  milesNorthOf,
  ORIGIN,
  TERM_END,
  TERM_START,
} from "../../utils/recommendation.fixtures";

/**
 * The safety property this whole change rests on (SCRUM-245): the SQL predicate
 * may only remove rows `calculateScore` would have rejected anyway. If a
 * bounding box could ever be tighter than the scorer's circle, the map would
 * silently lose matches, so it is tested as an invariant over many points
 * rather than with a handful of examples.
 */
describe("boundingBox — contains every point the scorer would accept", () => {
  // Deterministic sampling. A seeded generator rather than Math.random so a
  // failure is reproducible from the test name alone.
  const pseudoRandom = (seed: number) => {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  };

  const centres = [
    { name: "the origin", coord: ORIGIN },
    { name: "Boston", coord: BOSTON },
    { name: "a high northern latitude", coord: { lat: 71.0, lng: 25.8 } },
    { name: "a southern latitude", coord: { lat: -33.9, lng: 18.4 } },
  ];

  for (const centre of centres) {
    for (const radius of [1, 6, 19]) {
      it(`holds at ${centre.name} within ${radius} miles`, () => {
        const box = boundingBox(centre.coord.lat, centre.coord.lng, radius);
        const next = pseudoRandom(radius * 7919 + Math.round(centre.coord.lat));

        const latitudeRadians = (centre.coord.lat * Math.PI) / 180;
        const cosine = Math.cos(latitudeRadians);

        let accepted = 0;

        for (let i = 0; i < 2000; i++) {
          // Sampled in polar form and converted back through the same metric,
          // so points land inside the circle by construction rather than by
          // luck. Reaching past the radius keeps some outside for contrast.
          const bearing = next() * 2 * Math.PI;
          const distance = next() * radius * 1.4;

          const lat =
            centre.coord.lat +
            (distance * Math.cos(bearing)) / MILES_PER_DEGREE_LATITUDE;
          const lng =
            centre.coord.lng +
            (distance * Math.sin(bearing)) /
              (MILES_PER_DEGREE_LATITUDE * Math.max(cosine, 1e-6));

          if (
            milesBetween(centre.coord.lat, centre.coord.lng, lat, lng) > radius
          ) {
            continue;
          }

          accepted++;
          expect(lat).toBeGreaterThanOrEqual(box.latMin);
          expect(lat).toBeLessThanOrEqual(box.latMax);
          if (box.lngMin !== null && box.lngMax !== null) {
            expect(lng).toBeGreaterThanOrEqual(box.lngMin);
            expect(lng).toBeLessThanOrEqual(box.lngMax);
          }
        }

        // Guards against a vacuous pass: if the sampling never produced a point
        // inside the circle, the assertions above never ran.
        expect(accepted).toBeGreaterThan(500);
      });
    }
  }

  it("drops the longitude bound at the pole rather than spanning the globe", () => {
    const box = boundingBox(89.9999, 0, 19);

    expect(box.lngMin).toBeNull();
    expect(box.lngMax).toBeNull();
  });

  it("widens longitude more than latitude away from the equator", () => {
    const box = boundingBox(BOSTON.lat, BOSTON.lng, 6);

    const latSpan = box.latMax - box.latMin;
    const lngSpan = (box.lngMax as number) - (box.lngMin as number);

    expect(lngSpan).toBeGreaterThan(latSpan);
  });
});

/**
 * The same invariant, routed through the scorer itself: anything
 * `calculateScore` keeps under a distance filter must sit inside the box.
 */
describe("boundingBox agrees with calculateScore", () => {
  const rider = buildSearch({
    id: "current",
    role: Role.RIDER,
    home: BOSTON,
    company: BOSTON,
  });

  it("accepts nothing the home box would exclude", () => {
    const filters = anyFilters({ startDistance: 6 });
    const box = boundingBox(BOSTON.lat, BOSTON.lng, 6);

    // Ring of candidates straddling the 6-mile cutoff in both axes.
    for (const miles of [0, 3, 5.9, 6.1, 9]) {
      for (const place of [milesNorthOf, milesEastOf]) {
        const coord = place(BOSTON, miles);
        const candidate = buildSearch({
          id: `c-${miles}`,
          role: Role.DRIVER,
          home: coord,
          company: BOSTON,
        });

        const kept =
          calculateScore(rider, filters, "any")(candidate) !== undefined;

        if (kept) {
          expect(coord.lat).toBeGreaterThanOrEqual(box.latMin);
          expect(coord.lat).toBeLessThanOrEqual(box.latMax);
          expect(coord.lng).toBeGreaterThanOrEqual(box.lngMin as number);
          expect(coord.lng).toBeLessThanOrEqual(box.lngMax as number);
        }
      }
    }
  });
});

/**
 * The superset property for dates, checked against the object
 * `buildCandidateWhere` actually produces rather than a re-derivation of it.
 *
 * The date mirror is the fiddliest predicate in the module — a negated pair of
 * conjunctions — and a divergence from `calculateScore` would silently drop
 * matches instead of failing loudly. So the produced `where` is evaluated in
 * JavaScript over a grid of candidate terms and compared to the scorer's own
 * verdict. The rule is one-directional: SQL may keep rows the scorer later
 * rejects (a wasted read), but must never reject one the scorer would keep.
 */
describe("date overlap agrees with calculateScore", () => {
  /** Evaluates just the operators this module emits, against one candidate. */
  const matches = (
    clause: Record<string, any>,
    row: { startDate: Date | null; endDate: Date | null },
  ): boolean => {
    for (const [key, value] of Object.entries(clause)) {
      if (key === "AND") {
        if (!(value as any[]).every((sub) => matches(sub, row))) return false;
        continue;
      }
      if (key === "NOT") {
        if ((value as any[]).some((sub) => matches(sub, row))) return false;
        continue;
      }
      if (key !== "startDate" && key !== "endDate") continue;

      const actual = row[key as "startDate" | "endDate"];
      for (const [op, operand] of Object.entries(
        value as Record<string, any>,
      )) {
        if (op === "not" && operand === null) {
          if (actual === null) return false;
        } else if (actual === null) {
          return false;
        } else if (op === "lt" && !(actual < (operand as Date))) {
          return false;
        } else if (op === "lte" && !(actual <= (operand as Date))) {
          return false;
        } else if (op === "gt" && !(actual > (operand as Date))) {
          return false;
        } else if (op === "gte" && !(actual >= (operand as Date))) {
          return false;
        }
      }
    }
    return true;
  };

  const rider = buildSearch({ id: "current", role: Role.RIDER });

  // Terms straddling the filter window in every arrangement that matters:
  // entirely before, overlapping the start, inside, spanning, overlapping the
  // end, entirely after, and missing dates.
  const terms: { label: string; start: Date | null; end: Date | null }[] = [
    { label: "entirely before", start: day(2023, 1, 1), end: day(2023, 6, 1) },
    {
      label: "ends at the window start",
      start: day(2023, 6, 1),
      end: TERM_START,
    },
    {
      label: "overlaps the start",
      start: day(2023, 11, 1),
      end: day(2024, 3, 1),
    },
    { label: "strictly inside", start: day(2024, 2, 1), end: day(2024, 4, 1) },
    { label: "exactly the window", start: TERM_START, end: TERM_END },
    { label: "spans the window", start: day(2023, 6, 1), end: day(2025, 1, 1) },
    { label: "overlaps the end", start: day(2024, 5, 1), end: day(2024, 9, 1) },
    {
      label: "starts at the window end",
      start: TERM_END,
      end: day(2024, 9, 1),
    },
    { label: "entirely after", start: day(2025, 1, 1), end: day(2025, 6, 1) },
    { label: "no dates", start: null, end: null },
  ];

  for (const dateOverlap of [0, 1, 2]) {
    for (const term of terms) {
      it(`dateOverlap ${dateOverlap}: never excludes a kept term (${term.label})`, () => {
        const filters = anyFilters({
          dateOverlap,
          startDate: TERM_START,
          endDate: TERM_END,
        });

        const candidate = buildSearch({
          id: "candidate",
          role: Role.DRIVER,
          coopStart: term.start,
          coopEnd: term.end,
        });

        const scorerKeeps =
          calculateScore(rider, filters, "any")(candidate) !== undefined;

        const where = buildCandidateWhere({
          currentSearch: {
            role: Role.RIDER,
            carpoolId: null,
            homeLocation: null,
            companyLocation: null,
          },
          filters: { ...filters, favorites: false },
          excludedUserIds: [],
          favoriteUserIds: [],
        });

        const sqlKeeps = matches(
          { AND: where.AND ?? [] } as Record<string, any>,
          { startDate: term.start, endDate: term.end },
        );

        if (scorerKeeps) {
          expect(sqlKeeps).toBe(true);
        }
      });
    }
  }
});

describe("buildCandidateWhere — role compatibility", () => {
  const current = (role: Role, overrides: Partial<CurrentSearch> = {}) =>
    ({
      role,
      carpoolId: null,
      homeLocation: null,
      companyLocation: null,
      ...overrides,
    }) as CurrentSearch;

  const where = (role: Role, filters: Partial<FInputs> = {}) =>
    buildCandidateWhere({
      currentSearch: current(role),
      filters: { ...anyFilters(filters), favorites: false },
      excludedUserIds: ["me"],
      favoriteUserIds: [],
    });

  it("offers a rider only drivers, and only with a seat", () => {
    const result = where(Role.RIDER);

    expect(result.role).toEqual({ in: [Role.DRIVER] });
    expect(result.seatsAvail).toEqual({ not: 0 });
  });

  it("offers a driver only riders, and does not test seats", () => {
    const result = where(Role.DRIVER);

    expect(result.role).toEqual({ in: [Role.RIDER] });
    expect(result.seatsAvail).toBeUndefined();
  });

  it("offers a viewer both real roles", () => {
    const result = where(Role.VIEWER);

    expect(result.role).toEqual({ in: [Role.DRIVER, Role.RIDER] });
  });

  it("never offers a VIEWER as a candidate", () => {
    for (const role of [Role.RIDER, Role.DRIVER, Role.VIEWER]) {
      const roleFilter = where(role).role as { in: Role[] };
      expect(roleFilter.in).not.toContain(Role.VIEWER);
    }
  });

  it("always filters to active, onboarded rows and excludes the caller", () => {
    const result = where(Role.RIDER);

    expect(result.status).toBe(Status.ACTIVE);
    expect(result.user).toEqual({ isOnboarded: true });
    expect(result.userId).toEqual({ notIn: ["me"] });
  });
});

describe("buildCandidateWhere — group, favorites, bounds", () => {
  const base = {
    role: Role.RIDER,
    carpoolId: null,
    homeLocation: { coordLat: BOSTON.lat, coordLng: BOSTON.lng },
    companyLocation: { coordLat: BOSTON.lat, coordLng: BOSTON.lng },
  } satisfies CurrentSearch;

  const build = (
    currentSearch: CurrentSearch,
    filters: Partial<FInputs> = {},
    favorites = false,
    favoriteUserIds: string[] = [],
  ) =>
    buildCandidateWhere({
      currentSearch,
      filters: { ...anyFilters(filters), favorites },
      excludedUserIds: ["me"],
      favoriteUserIds,
    });

  it("excludes the caller's own group while keeping ungrouped users", () => {
    const result = build({ ...base, carpoolId: "group-1" });

    // The ungrouped branch matters: SQL's `!=` drops NULLs, so without it every
    // user without a group would vanish from the results.
    expect(result.OR).toEqual([
      { carpoolId: null },
      { carpoolId: { not: "group-1" } },
    ]);
  });

  it("adds no group filter when the caller has no group", () => {
    expect(build(base).OR).toBeUndefined();
  });

  it("narrows to favorites only when the filter asks", () => {
    expect(build(base, {}, true, ["a", "b"]).userId).toEqual({
      notIn: ["me"],
      in: ["a", "b"],
    });
    expect(build(base).userId).toEqual({ notIn: ["me"] });
  });

  it("bounds both locations when both distance filters are active", () => {
    const result = build(base, { startDistance: 6, endDistance: 10 });

    expect(result.homeLocation).toBeDefined();
    expect(result.companyLocation).toBeDefined();
  });

  it("adds no bound when the distance filter means any", () => {
    const result = build(base, { startDistance: 20, endDistance: 20 });

    expect(result.homeLocation).toBeUndefined();
    expect(result.companyLocation).toBeUndefined();
  });

  it("adds no bound when the caller has no coordinates to measure from", () => {
    const result = build(
      { ...base, homeLocation: null, companyLocation: null },
      { startDistance: 6, endDistance: 6 },
    );

    expect(result.homeLocation).toBeUndefined();
    expect(result.companyLocation).toBeUndefined();
  });
});

describe("buildCandidateWhere — date overlap", () => {
  const build = (dateOverlap: number) =>
    buildCandidateWhere({
      currentSearch: {
        role: Role.RIDER,
        carpoolId: null,
        homeLocation: null,
        companyLocation: null,
      },
      filters: {
        ...anyFilters({
          dateOverlap,
          startDate: TERM_START,
          endDate: TERM_END,
        }),
        favorites: false,
      },
      excludedUserIds: [],
      favoriteUserIds: [],
    });

  it("adds nothing when any overlap will do", () => {
    expect(build(0).AND).toBeUndefined();
  });

  it("requires the term to span the window for a full overlap", () => {
    expect(build(2).AND).toEqual([
      {
        startDate: { not: null, lte: TERM_START },
        endDate: { not: null, gte: TERM_END },
      },
    ]);
  });

  it("negates the two disjoint cases for a partial overlap", () => {
    expect(build(1).AND).toEqual([
      {
        startDate: { not: null },
        endDate: { not: null },
        NOT: [
          {
            AND: [
              { startDate: { lt: TERM_START } },
              { endDate: { lt: TERM_START } },
            ],
          },
          {
            AND: [
              { endDate: { gt: TERM_END } },
              { startDate: { gt: TERM_END } },
            ],
          },
        ],
      },
    ]);
  });
});

describe("rankCandidates", () => {
  const rider = buildSearch({ id: "current", role: Role.RIDER });

  it("orders best match first", () => {
    const near = buildSearch({
      id: "near",
      role: Role.DRIVER,
      home: milesNorthOf(ORIGIN, 1),
    });
    const far = buildSearch({
      id: "far",
      role: Role.DRIVER,
      home: milesNorthOf(ORIGIN, 5),
    });

    const ranked = rankCandidates([far, near], rider, anyFilters(), "any");

    expect(ranked.map((c) => c.user.id)).toEqual(["near", "far"]);
  });

  it("drops candidates the scorer rejects rather than returning holes", () => {
    const driver = buildSearch({ id: "keep", role: Role.DRIVER });
    // A rider is not a match for another rider.
    const otherRider = buildSearch({ id: "drop", role: Role.RIDER });

    const ranked = rankCandidates(
      [driver, otherRider],
      rider,
      anyFilters(),
      "any",
    );

    expect(ranked.map((c) => c.user.id)).toEqual(["keep"]);
    expect(ranked).not.toContain(undefined);
  });

  it("returns the original rows, not copies", () => {
    const driver = buildSearch({ id: "keep", role: Role.DRIVER });

    const ranked = rankCandidates([driver], rider, anyFilters(), "any");

    expect(ranked[0]).toBe(driver);
  });

  it("keeps every scored candidate when the whole set matches", () => {
    const candidates = [1, 2, 3, 4, 5].map((n) =>
      buildSearch({
        id: `d${n}`,
        role: Role.DRIVER,
        home: milesNorthOf(ORIGIN, n),
      }),
    );

    const ranked = rankCandidates(candidates, rider, anyFilters(), "any");

    expect(ranked).toHaveLength(5);
    expect(ranked.map((c) => c.user.id)).toEqual([
      "d1",
      "d2",
      "d3",
      "d4",
      "d5",
    ]);
  });
});

describe("CANDIDATE_LIMIT", () => {
  it("sits above both endpoints' result slices so it does not shape results", () => {
    // The map keeps 150 and recommendations 50; the bound exists to cap cost,
    // not to paginate.
    expect(CANDIDATE_LIMIT).toBeGreaterThan(150);
  });
});
