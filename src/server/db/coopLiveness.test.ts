import { coopYearBounds } from "../../utils/dateUtils";
import {
  coopEndsBeforeYearCeilingFilter,
  coopEndsBeforeYearCeilingSql,
  coopHasNotEndedFilter,
  coopHasNotEndedSql,
  coopIsLiveFilter,
  coopIsLiveSql,
  coopLivenessBoundary,
  coopLivenessDay,
  coopYearCeilingBoundary,
  coopYearCeilingDay,
} from "./coopLiveness";

/**
 * The two boundaries and the renderings of them.
 *
 * What this file can prove is that each day is computed and that both
 * renderings carry it. What it deliberately does **not** attempt is whether
 * the predicate selects the right rows — a mocked Prisma returns whatever the
 * test says, so an assertion here would only restate the clause. That is
 * `coopHasNotEnded.db.test.ts`'s job, against real MySQL, and the four-case
 * table SCRUM-631 asks for lives there rather than here for the same reason.
 */

describe("coopLivenessBoundary", () => {
  it("is midnight UTC on the UTC day containing the instant", () => {
    expect(coopLivenessBoundary(new Date("2026-10-27T13:45:12.345Z"))).toEqual(
      new Date("2026-10-27T00:00:00.000Z"),
    );
  });

  /**
   * The regression that matters, and the reason every getter in the
   * implementation is a `getUTC*` one.
   *
   * 03:00 UTC on the 27th is 23:00 on the **26th** in `America/New_York`, so
   * an implementation built from local getters returns a different day here
   * than it does under UTC. CI runs Jest twice, once in each zone
   * (`jest.shared.config.js`), so this assertion fails in exactly one arm if
   * anyone reaches for `getFullYear` — which is the failure a single-zone run
   * would miss.
   */
  it("gives the UTC day even when the local day differs", () => {
    expect(coopLivenessBoundary(new Date("2026-10-27T03:00:00.000Z"))).toEqual(
      new Date("2026-10-27T00:00:00.000Z"),
    );
  });

  it("keeps an instant already at midnight UTC where it is", () => {
    expect(coopLivenessBoundary(new Date("2026-10-27T00:00:00.000Z"))).toEqual(
      new Date("2026-10-27T00:00:00.000Z"),
    );
  });
});

describe("coopLivenessDay", () => {
  it("renders the boundary as a bare YYYY-MM-DD", () => {
    expect(coopLivenessDay(new Date("2026-10-27T13:45:12.345Z"))).toBe(
      "2026-10-27",
    );
  });

  it("agrees with the boundary it is derived from, in either zone", () => {
    const now = new Date("2026-10-27T03:00:00.000Z");

    expect(coopLivenessDay(now)).toBe(
      coopLivenessBoundary(now).toISOString().slice(0, 10),
    );
  });
});

describe("coopHasNotEndedFilter", () => {
  const now = new Date("2026-10-27T13:45:12.345Z");

  it("admits a null end date alongside one at or after the boundary", () => {
    expect(coopHasNotEndedFilter(now)).toEqual({
      OR: [
        { endDate: null },
        { endDate: { gte: new Date("2026-10-27T00:00:00.000Z") } },
      ],
    });
  });

  /**
   * `gte`, not `gt`. `end_date` holds the last day of the co-op, so a search
   * ending today is still running today. Asserted on the operator itself
   * because the database test can only catch the flip on a day when a fixture
   * sits exactly on the boundary, and this catches it on every run.
   */
  it("uses an inclusive comparison, so a co-op ending today survives", () => {
    const [, dated] = coopHasNotEndedFilter(now).OR as [
      unknown,
      { endDate: Record<string, unknown> },
    ];

    expect(Object.keys(dated.endDate)).toEqual(["gte"]);
  });
});

describe("coopHasNotEndedSql", () => {
  const now = new Date("2026-10-27T13:45:12.345Z");

  it("interpolates the alias as an identifier and the day as a parameter", () => {
    const fragment = coopHasNotEndedSql("cs", now);

    expect(fragment.sql).toBe("(cs.end_date IS NULL OR cs.end_date >= ?)");
    expect(fragment.values).toEqual(["2026-10-27"]);
  });

  /**
   * A bare date string, never a `Date`. `end_date` is `@db.Date`, so binding a
   * timestamp invites the driver to resolve it through a session time zone and
   * land a day either side of the one meant — the trap SCRUM-631 flagged.
   */
  it("binds a date string rather than a timestamp", () => {
    expect(typeof coopHasNotEndedSql("cs", now).values[0]).toBe("string");
  });

  it("is parenthesised, so ANDing it into a WHERE cannot capture the OR", () => {
    const { sql } = coopHasNotEndedSql("cs", now);

    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
  });

  /**
   * The anti-drift property the two renderings exist under: they may be
   * written in different languages, but they may not disagree about the day.
   */
  it("carries the same day as the Prisma rendering", () => {
    const [, dated] = coopHasNotEndedFilter(now).OR as [
      unknown,
      { endDate: { gte: Date } },
    ];

    expect(coopHasNotEndedSql("cs", now).values[0]).toBe(
      dated.endDate.gte.toISOString().slice(0, 10),
    );
  });
});

describe("coopYearCeilingBoundary", () => {
  it("is midnight UTC on 1 January after the coopYearBounds ceiling", () => {
    // 2026 + COOP_YEARS_AHEAD is 2036, so the first instant that is too late
    // is the start of 2037.
    expect(
      coopYearCeilingBoundary(new Date("2026-10-27T13:45:12.345Z")),
    ).toEqual(new Date("2037-01-01T00:00:00.000Z"));
  });

  /**
   * SCRUM-699 AC 2: the bound is **derived** from `coopYearBounds` rather than
   * re-typed here. Asserted against that function at two clocks a decade
   * apart, because a literal passes the single-date case above and fails the
   * moment the relative ceiling moves — which it does every 1 January.
   */
  it("tracks coopYearBounds rather than hard-coding its ceiling", () => {
    for (const iso of [
      "2026-10-27T13:45:12.345Z",
      "2036-03-04T00:00:00.000Z",
    ]) {
      const now = new Date(iso);

      expect(coopYearCeilingBoundary(now).getUTCFullYear()).toBe(
        coopYearBounds(now).latest + 1,
      );
    }
  });

  /**
   * The same regression `coopLivenessBoundary` guards, one unit up: 03:00 UTC
   * on 1 January is still 31 December in `America/New_York`, so an
   * implementation reaching for `getFullYear` lands a whole year early. CI
   * runs Jest in both zones, so this fails in exactly one arm.
   */
  it("gives the UTC year even when the local year differs", () => {
    expect(
      coopYearCeilingBoundary(new Date("2027-01-01T03:00:00.000Z")),
    ).toEqual(new Date("2038-01-01T00:00:00.000Z"));
  });
});

describe("coopYearCeilingDay", () => {
  it("renders the ceiling as a bare YYYY-MM-DD", () => {
    expect(coopYearCeilingDay(new Date("2026-10-27T13:45:12.345Z"))).toBe(
      "2037-01-01",
    );
  });

  it("agrees with the boundary it is derived from, in either zone", () => {
    const now = new Date("2027-01-01T03:00:00.000Z");

    expect(coopYearCeilingDay(now)).toBe(
      coopYearCeilingBoundary(now).toISOString().slice(0, 10),
    );
  });
});

describe("coopEndsBeforeYearCeilingFilter", () => {
  const now = new Date("2026-10-27T13:45:12.345Z");

  it("admits a null end date alongside one before the ceiling", () => {
    expect(coopEndsBeforeYearCeilingFilter(now)).toEqual({
      OR: [
        { endDate: null },
        { endDate: { lt: new Date("2037-01-01T00:00:00.000Z") } },
      ],
    });
  });

  /**
   * `lt`, not `lte`. The boundary is the first instant that is *too late*, so
   * an inclusive comparison would admit 1 January of the year past the
   * ceiling — a whole year of dates `coopYearBounds` calls implausible.
   */
  it("uses an exclusive comparison against the start of the year after", () => {
    const [, dated] = coopEndsBeforeYearCeilingFilter(now).OR as [
      unknown,
      { endDate: Record<string, unknown> },
    ];

    expect(Object.keys(dated.endDate)).toEqual(["lt"]);
  });
});

describe("coopEndsBeforeYearCeilingSql", () => {
  const now = new Date("2026-10-27T13:45:12.345Z");

  it("interpolates the alias as an identifier and the day as a parameter", () => {
    const fragment = coopEndsBeforeYearCeilingSql("cs", now);

    expect(fragment.sql).toBe("(cs.end_date IS NULL OR cs.end_date < ?)");
    expect(fragment.values).toEqual(["2037-01-01"]);
  });

  it("binds a date string rather than a timestamp", () => {
    expect(typeof coopEndsBeforeYearCeilingSql("cs", now).values[0]).toBe(
      "string",
    );
  });

  it("is parenthesised, so ANDing it into a WHERE cannot capture the OR", () => {
    const { sql } = coopEndsBeforeYearCeilingSql("cs", now);

    expect(sql.startsWith("(")).toBe(true);
    expect(sql.endsWith(")")).toBe(true);
  });

  it("carries the same day as the Prisma rendering", () => {
    const [, dated] = coopEndsBeforeYearCeilingFilter(now).OR as [
      unknown,
      { endDate: { lt: Date } },
    ];

    expect(coopEndsBeforeYearCeilingSql("cs", now).values[0]).toBe(
      dated.endDate.lt.toISOString().slice(0, 10),
    );
  });
});

/**
 * The composition, which is the only thing the callers touch.
 *
 * Asserted against the two halves rather than against a spelled-out clause, so
 * a change to either half flows through instead of having to be copied here —
 * and so the thing being pinned is "liveness is exactly these two, in this
 * order", which is the property a later edit could break silently.
 */
describe("coopIsLiveFilter", () => {
  const now = new Date("2026-10-27T13:45:12.345Z");

  it("ANDs the floor and the ceiling, unchanged", () => {
    expect(coopIsLiveFilter(now)).toEqual({
      AND: [coopHasNotEndedFilter(now), coopEndsBeforeYearCeilingFilter(now)],
    });
  });

  /**
   * Both halves admit a null, so the composition does too — SCRUM-631's
   * decision, which SCRUM-699 was explicitly not allowed to reverse.
   */
  it("still admits a dateless search", () => {
    const [floor, ceiling] = coopIsLiveFilter(now).AND as [
      { OR: unknown[] },
      { OR: unknown[] },
    ];

    expect(floor.OR[0]).toEqual({ endDate: null });
    expect(ceiling.OR[0]).toEqual({ endDate: null });
  });
});

describe("coopIsLiveSql", () => {
  const now = new Date("2026-10-27T13:45:12.345Z");

  it("ANDs the two fragments inside one further pair of brackets", () => {
    const fragment = coopIsLiveSql("cs", now);

    expect(fragment.sql).toBe(
      "((cs.end_date IS NULL OR cs.end_date >= ?) AND" +
        " (cs.end_date IS NULL OR cs.end_date < ?))",
    );
    expect(fragment.values).toEqual(["2026-10-27", "2037-01-01"]);
  });

  it("carries the same two days as the Prisma rendering", () => {
    const [floor, ceiling] = coopIsLiveFilter(now).AND as [
      { OR: [unknown, { endDate: { gte: Date } }] },
      { OR: [unknown, { endDate: { lt: Date } }] },
    ];

    expect(coopIsLiveSql("cs", now).values).toEqual([
      floor.OR[1].endDate.gte.toISOString().slice(0, 10),
      ceiling.OR[1].endDate.lt.toISOString().slice(0, 10),
    ]);
  });
});
