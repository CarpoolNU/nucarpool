import { Role } from "@prisma/client";
import { buildSearch } from "../../utils/recommendation.fixtures";
import {
  RIDER_DEMAND_FLOOR,
  riderDemandToDisplay,
} from "../../utils/riderDemand/floor";
import { buildCandidateWhere } from "./candidateSearch";
import {
  RIDER_DEMAND_RADIUS_MILES,
  asHypotheticalDriver,
  readerSeesRiderDemand,
  riderDemandFilters,
} from "./riderDemand";

/**
 * The rules behind the rider-demand count, without a database.
 *
 * `riderDemand.db.test.ts` proves the count is *right* against real rows,
 * which is the only place the three SQL exclusions can be demonstrated. This
 * file proves the decisions around it: who is asked, what the hypothetical
 * changes, and that the floor suppresses rather than rounds.
 *
 * The last `describe` is the regression SCRUM-638 asks for. Reusing
 * `buildCandidateWhere` is the entire design, so the risk this ticket
 * introduces is not that the new query is wrong — it is that serving it
 * quietly changed the forward one, and every rider on the platform would see
 * a different list with nothing pointing at why.
 */

describe("riderDemandToDisplay", () => {
  it("shows a count at the floor and above", () => {
    expect(riderDemandToDisplay(RIDER_DEMAND_FLOOR)).toBe(RIDER_DEMAND_FLOOR);
    expect(riderDemandToDisplay(RIDER_DEMAND_FLOOR + 40)).toBe(
      RIDER_DEMAND_FLOOR + 40,
    );
  });

  it("suppresses every count below the floor, including zero", () => {
    for (let count = 0; count < RIDER_DEMAND_FLOOR; count++) {
      expect(riderDemandToDisplay(count)).toBeNull();
    }
  });

  it("gives the same answer for zero as for one below the floor", () => {
    // The point of the floor, stated as a test: a reader cannot work out
    // which of the suppressed counts they are, because the return value does
    // not distinguish them. A floor that answered "0" for nobody and `null`
    // for two would have narrowed the range it exists to hide.
    expect(riderDemandToDisplay(0)).toEqual(
      riderDemandToDisplay(RIDER_DEMAND_FLOOR - 1),
    );
  });

  it("is at least three, so a VIEWER cannot line a count up against map pins", () => {
    // `floor.ts` carries the argument. This pins the conclusion so that
    // lowering the constant is a decision someone has to take deliberately
    // rather than a one-character edit that nothing notices.
    expect(RIDER_DEMAND_FLOOR).toBeGreaterThanOrEqual(3);
  });
});

describe("readerSeesRiderDemand", () => {
  it("answers a rider and a viewer", () => {
    expect(readerSeesRiderDemand({ role: Role.RIDER, carpoolId: null })).toBe(
      true,
    );
    expect(readerSeesRiderDemand({ role: Role.VIEWER, carpoolId: null })).toBe(
      true,
    );
  });

  it("does not answer a driver, who is already looking at the list", () => {
    expect(readerSeesRiderDemand({ role: Role.DRIVER, carpoolId: null })).toBe(
      false,
    );
  });

  it("does not answer a reader in a group, whose role control is locked", () => {
    // `UserSection` disables the radios for them. Urging an action the form
    // refuses is the nagging the ticket warns against.
    expect(
      readerSeesRiderDemand({ role: Role.RIDER, carpoolId: "group-1" }),
    ).toBe(false);
  });

  it("does not answer a reader with no search at all", () => {
    expect(readerSeesRiderDemand(null)).toBe(false);
    expect(readerSeesRiderDemand(undefined)).toBe(false);
  });
});

describe("asHypotheticalDriver", () => {
  it("gives the hypothetical a seat, so the searcher is not unmatchable", () => {
    // A rider's own row carries `seatsAvail: 0`. Inheriting it would make
    // `searcherCanMatchNobody` true, `buildCandidateWhere` empty the result,
    // and the feature never fire for anybody.
    const rider = buildSearch({ role: Role.RIDER, seatsAvail: 0 });
    const hypothetical = asHypotheticalDriver(rider);

    expect(hypothetical.role).toBe(Role.DRIVER);
    expect(hypothetical.seatsAvail).toBeGreaterThan(0);
  });

  it("leaves the reader's own route and group state alone", () => {
    const rider = buildSearch({
      role: Role.RIDER,
      carpoolId: "group-1",
      daysWorking: "1,0,0,0,0,0,1",
    });
    const hypothetical = asHypotheticalDriver(rider);

    // The question is about *this* commute. A hypothetical that moved the
    // geography would be answering somebody else's.
    expect(hypothetical.homeLocation).toBe(rider.homeLocation);
    expect(hypothetical.companyLocation).toBe(rider.companyLocation);
    expect(hypothetical.carpoolId).toBe(rider.carpoolId);
    expect(hypothetical.daysWorking).toBe(rider.daysWorking);
  });

  it("does not mutate the search it was given", () => {
    // The caller holds the reader's real row, and the explore page renders
    // from it. Mutating it here would turn a rider into a driver on screen.
    const rider = buildSearch({ role: Role.RIDER, seatsAvail: 0 });
    asHypotheticalDriver(rider);

    expect(rider.role).toBe(Role.RIDER);
    expect(rider.seatsAvail).toBe(0);
  });
});

describe("riderDemandFilters", () => {
  const filters = riderDemandFilters({
    startDate: new Date("2026-01-01"),
    endDate: new Date("2026-06-01"),
  });

  it("bounds both ends of the route rather than counting the whole platform", () => {
    // The platform's own default is "any distance", which would make this
    // "287 riders exist" rather than "riders on your way to work".
    expect(filters.startDistance).toBe(RIDER_DEMAND_RADIUS_MILES);
    expect(filters.endDistance).toBe(RIDER_DEMAND_RADIUS_MILES);
  });

  it("applies no date-overlap preference, leaving liveness as the only date rule", () => {
    expect(filters.dateOverlap).toBe(0);
  });

  it("applies no day or time preference the reader never expressed", () => {
    expect(filters.days).toBe(0);
    expect(filters.daysWorking).toBe("");
  });

  it("falls back to a usable window for a search holding no dates", () => {
    const dateless = riderDemandFilters({ startDate: null, endDate: null });

    expect(dateless.startDate).toBeInstanceOf(Date);
    expect(dateless.endDate).toBeInstanceOf(Date);
  });
});

describe("the forward recommendation path is unchanged", () => {
  /**
   * The regression the ticket names. `buildCandidateWhere` is shared, so a
   * change made to serve the count would land on every rider's list.
   *
   * Written as a value assertion rather than a snapshot: a snapshot would be
   * updated by whoever broke it, and the two properties below are the ones
   * that would actually matter.
   */
  const forwardWhere = (role: Role) =>
    buildCandidateWhere({
      currentSearch: buildSearch({
        role,
        seatsAvail: role === Role.DRIVER ? 3 : 0,
      }),
      filters: {
        ...riderDemandFilters({ startDate: null, endDate: null }),
        startDistance: 20,
        endDistance: 20,
      },
      excludedUserIds: ["self"],
      favoriteUserIds: [],
    });

  it("still offers a rider only drivers", () => {
    expect(forwardWhere(Role.RIDER).role).toEqual({ in: [Role.DRIVER] });
  });

  it("still offers a driver only riders, and only ungrouped ones", () => {
    const where = forwardWhere(Role.DRIVER);

    expect(where.role).toEqual({ in: [Role.RIDER] });
    expect(where.carpoolId).toBeNull();
  });

  it("still requires a seat of a rider's candidates", () => {
    expect(forwardWhere(Role.RIDER).seatsAvail).toBeDefined();
  });

  it("still applies the liveness rule unconditionally", () => {
    // `coopIsLiveFilter` is collected into `AND`. Its presence is what this
    // ticket depends on; its being there for the *forward* query too is what
    // this test is about.
    expect(Array.isArray(forwardWhere(Role.RIDER).AND)).toBe(true);
    expect((forwardWhere(Role.RIDER).AND as unknown[]).length).toBeGreaterThan(
      0,
    );
  });
});
