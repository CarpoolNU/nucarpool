import { Role, Status } from "@prisma/client";
import {
  countRows,
  headroom,
  measureHeadroom,
  reduction,
  widestFilters,
  WIDEST_SUBJECTS,
} from "./measure-candidate-rows";
import {
  buildCandidateWhere,
  CANDIDATE_LIMIT,
} from "../src/server/db/candidateSearch";
import { searcherCanMatchNobody } from "../src/utils/candidateReachability";
import { SEAT_AVAILABLE_FILTER } from "../src/utils/carpoolSeats";

/**
 * Tested because a measurement
 * that quietly counts wrong is worse than no measurement.
 */
describe("countRows", () => {
  const row = (id: string, home: string, company: string) => ({
    userId: id,
    homeLocationId: home,
    companyLocationId: company,
  });

  it("counts one user and two locations per search", () => {
    expect(countRows([row("a", "h1", "c1")])).toEqual({
      carpoolSearch: 1,
      location: 2,
      user: 1,
      total: 4,
    });
  });

  it("counts a shared location once, because Prisma fetches it once", () => {
    // Two searches pointing at the same company row: the include is a single
    // `IN (...)`, so that row is read once, not twice.
    const counts = countRows([
      row("a", "h1", "shared"),
      row("b", "h2", "shared"),
    ]);

    expect(counts.location).toBe(3);
    expect(counts.total).toBe(3 + 2 + 2);
  });

  it("is zero for an empty result", () => {
    expect(countRows([])).toEqual({
      carpoolSearch: 0,
      location: 0,
      user: 0,
      total: 0,
    });
  });
});

describe("reduction", () => {
  it("reports the percentage saved", () => {
    expect(reduction(100, 25)).toBe(75);
  });

  it("is zero when nothing was saved", () => {
    expect(reduction(50, 50)).toBe(0);
  });

  it("does not report a negative saving when the bounded query read more", () => {
    expect(reduction(10, 20)).toBe(0);
  });

  it("handles an empty database without dividing by zero", () => {
    expect(reduction(0, 0)).toBe(0);
  });
});

/**
 * The ceiling half, added under SCRUM-643.
 *
 * `reduction` above answers "did the optimisation help". These answer "is the
 * bound it introduced still comfortable" — a different question with a
 * different worst case, and the one the two scenarios in `main` are built to
 * get wrong, because they pick the subject that maximises the apparent saving.
 */
describe("WIDEST_SUBJECTS", () => {
  it("covers every role, so the worst case cannot be the one left out", () => {
    expect([...WIDEST_SUBJECTS.map((s) => s.role)].sort()).toEqual(
      [Role.DRIVER, Role.RIDER, Role.VIEWER].sort(),
    );
  });

  it("carries no coordinates, so no bounding box narrows the pool", () => {
    // A real subject would have both. That is the whole reason these are
    // synthetic: the ceiling applies to the unfiltered pool.
    for (const subject of WIDEST_SUBJECTS) {
      expect(subject.homeLocation).toBeNull();
      expect(subject.companyLocation).toBeNull();
    }
  });

  it("disarms both halves of searcherCanMatchNobody", () => {
    // Either one would empty the result set before a candidate is looked at,
    // and a measurement of zero would read as enormous headroom.
    for (const subject of WIDEST_SUBJECTS) {
      expect(searcherCanMatchNobody(subject)).toBe(false);
    }
  });
});

describe("the widest where, against the SQL the figures were measured with", () => {
  /**
   * SCRUM-643's production figures were taken with `pscale sql`, because no
   * Prisma script can reach that database. These pin the predicate this script
   * builds to the one those queries ran, so a recorded figure and a future run
   * of this script are answering the same question.
   */
  const whereFor = (role: Role) => {
    const subject = WIDEST_SUBJECTS.find((s) => s.role === role);
    if (!subject) throw new Error(`no widest subject for ${role}`);

    return buildCandidateWhere({
      currentSearch: subject,
      filters: widestFilters(),
      excludedUserIds: [],
      favoriteUserIds: [],
    });
  };

  const everyRole = [Role.RIDER, Role.DRIVER, Role.VIEWER];

  it("always requires an ACTIVE search belonging to an onboarded user", () => {
    for (const role of everyRole) {
      const where = whereFor(role);
      expect(where.status).toBe(Status.ACTIVE);
      expect(where.user).toEqual({ isOnboarded: true });
    }
  });

  it("narrows nothing by location or date at the widest filters", () => {
    for (const role of everyRole) {
      const where = whereFor(role);
      expect(where.homeLocation).toBeUndefined();
      expect(where.companyLocation).toBeUndefined();
      expect(where.AND).toBeUndefined();
    }
  });

  it("empties nobody's result set", () => {
    for (const role of everyRole) {
      expect(whereFor(role).id).toBeUndefined();
    }
  });

  it("asks a RIDER's query for drivers with a seat", () => {
    // SQL: role = 'DRIVER' AND seats_avail > 0
    const where = whereFor(Role.RIDER);
    expect(where.role).toEqual({ in: [Role.DRIVER] });
    expect(where.seatsAvail).toEqual(SEAT_AVAILABLE_FILTER);
    expect(where.carpoolId).toBeUndefined();
  });

  it("asks a DRIVER's query for ungrouped riders", () => {
    // SQL: role = 'RIDER' AND carpoolId IS NULL. The figure recorded in
    // candidateSearch.ts before this ticket omitted the group half, which is
    // why staging's DRIVER case was quoted as 685 rather than 667.
    const where = whereFor(Role.DRIVER);
    expect(where.role).toEqual({ in: [Role.RIDER] });
    expect(where.carpoolId).toBeNull();
    expect(where.seatsAvail).toBeUndefined();
  });

  it("asks a VIEWER's query for both roles, with neither narrowing", () => {
    // SQL: role IN ('DRIVER','RIDER'). No seat test and no group test, which
    // is precisely why a VIEWER is the worst case and not merely another one.
    const where = whereFor(Role.VIEWER);
    expect(where.role).toEqual({ in: [Role.DRIVER, Role.RIDER] });
    expect(where.seatsAvail).toBeUndefined();
    expect(where.carpoolId).toBeUndefined();
  });
});

describe("headroom", () => {
  it("reports the share of the ceiling and the growth left", () => {
    // Half the ceiling needs a doubling to reach it.
    expect(headroom(Role.VIEWER, CANDIDATE_LIMIT / 2)).toEqual({
      role: Role.VIEWER,
      rows: CANDIDATE_LIMIT / 2,
      percentOfLimit: 50,
      growthToBreach: 100,
    });
  });

  it("reproduces the figure SCRUM-643 recorded for production", () => {
    // Measured read-only against the PlanetScale `main` branch, 2026-10-08.
    // This is what makes the figure in candidateSearch.ts checkable rather
    // than merely quoted.
    const measured = headroom(Role.VIEWER, 1463);

    expect(measured.percentOfLimit).toBe(73);
    expect(measured.growthToBreach).toBe(37);
  });

  it("reproduces the figure SCRUM-643 recorded for staging", () => {
    // The same day, the same predicate, a different database: 38% against
    // 73%. Staging is production-derived and much smaller, which is how the
    // comment this ticket corrected came to understate production by half.
    expect(headroom(Role.VIEWER, 751).percentOfLimit).toBe(38);
  });

  it("stops reporting growth once the ceiling is already breached", () => {
    // Past the ceiling "how much growth until it truncates" has no answer, and
    // a negative percentage there would read as headroom.
    expect(
      headroom(Role.VIEWER, CANDIDATE_LIMIT + 1).growthToBreach,
    ).toBeNull();
  });

  it("does not divide by zero on an empty database", () => {
    expect(headroom(Role.RIDER, 0)).toEqual({
      role: Role.RIDER,
      rows: 0,
      percentOfLimit: 0,
      growthToBreach: (CANDIDATE_LIMIT - 1) * 100,
    });
  });
});

describe("measureHeadroom", () => {
  it("counts without a take bound, which would cap the answer at the ceiling", async () => {
    // `findMany({ take: CANDIDATE_LIMIT })` cannot observe a pool larger than
    // CANDIDATE_LIMIT, so it could never report the breach this exists to
    // detect. `include` is absent for the reason `headroom` documents: the
    // bound applies to carpool_search rows alone.
    const count = jest.fn().mockResolvedValue(1463);

    const results = await measureHeadroom({ carpoolSearch: { count } });

    expect(count).toHaveBeenCalledTimes(3);
    for (const [args] of count.mock.calls) {
      expect(args).not.toHaveProperty("take");
      expect(args).not.toHaveProperty("include");
    }
    expect(results.map((r) => r.percentOfLimit)).toEqual([73, 73, 73]);
  });

  it("reports one row per role, in a stable order", async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(66)
      .mockResolvedValueOnce(1317)
      .mockResolvedValueOnce(1463);

    const results = await measureHeadroom({ carpoolSearch: { count } });

    // Production, 2026-10-08. A RIDER is filtered hardest, a VIEWER least.
    expect(results).toEqual([
      expect.objectContaining({ role: Role.RIDER, rows: 66 }),
      expect.objectContaining({ role: Role.DRIVER, rows: 1317 }),
      expect.objectContaining({ role: Role.VIEWER, rows: 1463 }),
    ]);
  });
});
