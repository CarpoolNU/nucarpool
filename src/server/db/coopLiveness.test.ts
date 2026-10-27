import {
  coopHasNotEndedFilter,
  coopHasNotEndedSql,
  coopLivenessBoundary,
  coopLivenessDay,
} from "./coopLiveness";

/**
 * The boundary and the two renderings of it.
 *
 * What this file can prove is that one day is computed and that both
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
