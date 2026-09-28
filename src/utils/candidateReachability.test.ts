import { Role } from "@prisma/client";
import {
  UNGROUPED_CANDIDATE_FILTER,
  candidateIsUngrouped,
  searcherCanMatchNobody,
} from "./candidateReachability";
import { hasSeatAvailable } from "./carpoolSeats";

/**
 * The content of the group rules, in one place.
 *
 * `candidateSearch.test.ts`'s "group exclusion agrees with calculateScore"
 * proves the two callers *agree*; nothing there proves they agree on the right
 * thing, because a change to the shared predicate moves both sides together.
 * That is the division of labour: this file pins what the rules say, that one
 * pins that both callers still say it.
 */

const SEATS = [-1, 0, 1, 4] as const;
const GROUPS = [null, "group-1"] as const;

describe("searcherCanMatchNobody", () => {
  const search = (
    role: Role,
    carpoolId: string | null,
    seatsAvail: number,
  ) => ({ role, carpoolId, seatsAvail });

  describe("a rider", () => {
    it.each(GROUPS)("depends only on their own group (%s)", (carpoolId) => {
      for (const seatsAvail of SEATS) {
        expect(
          searcherCanMatchNobody(search(Role.RIDER, carpoolId, seatsAvail)),
        ).toBe(carpoolId !== null);
      }
    });

    it("is unmatchable once grouped, not merely barred from their own group", () => {
      // The rule this replaced compared the two groups, which left every
      // *other* group's driver on offer - and `connectAction` refuses each of
      // them with CONFLICT, because `groups.ts` needs the rider's own
      // `carpoolId` to be null before it can link them anywhere.
      expect(searcherCanMatchNobody(search(Role.RIDER, "group-1", 0))).toBe(
        true,
      );
    });
  });

  describe("a driver", () => {
    it.each(SEATS)("depends only on their own seats (%i)", (seatsAvail) => {
      for (const carpoolId of GROUPS) {
        expect(
          searcherCanMatchNobody(search(Role.DRIVER, carpoolId, seatsAvail)),
        ).toBe(!hasSeatAvailable(seatsAvail));
      }
    });

    it("is not the mirror of the rider rule: a group of their own is fine", () => {
      // A grouped driver with a seat left is still a valid candidate for an
      // ungrouped rider, which is the asymmetry `UNGROUPED_CANDIDATE_FILTER`
      // narrows on the candidate side instead.
      expect(searcherCanMatchNobody(search(Role.DRIVER, "group-1", 2))).toBe(
        false,
      );
    });

    it("counts a negative seat count as no seats, as `reserveSeat` does", () => {
      expect(searcherCanMatchNobody(search(Role.DRIVER, null, -1))).toBe(true);
    });
  });

  it("never empties a viewer's result set, whose role decides it earlier", () => {
    // Discovery excludes VIEWERs as *candidates*; a reader in Viewer mode is
    // narrowed by role compatibility, not by these rules, so neither applies.
    for (const carpoolId of GROUPS) {
      for (const seatsAvail of SEATS) {
        expect(
          searcherCanMatchNobody(search(Role.VIEWER, carpoolId, seatsAvail)),
        ).toBe(false);
      }
    }
  });

  it("treats a row selected without `carpoolId` as ungrouped", () => {
    // The direction that reads too many candidates rather than hiding
    // reachable ones.
    expect(
      searcherCanMatchNobody({
        role: Role.RIDER,
        carpoolId: undefined as unknown as null,
        seatsAvail: 0,
      }),
    ).toBe(false);
  });
});

describe("candidateIsUngrouped", () => {
  it("is true for a row with no group and false for one with any group", () => {
    expect(candidateIsUngrouped({ carpoolId: null })).toBe(true);
    expect(candidateIsUngrouped({ carpoolId: undefined })).toBe(true);
    expect(candidateIsUngrouped({})).toBe(true);
    expect(candidateIsUngrouped({ carpoolId: "group-1" })).toBe(false);
    // Any group, not just the reader's - a rider in someone else's group is
    // just as unacceptable, which is the case the old group comparison missed.
    expect(candidateIsUngrouped({ carpoolId: "group-2" })).toBe(false);
  });
});

/**
 * The `SEAT_AVAILABLE_FILTER` treatment, for the one rule that has to exist as
 * both a Prisma filter and a JS predicate: the filter is evaluated in
 * JavaScript and compared to the predicate, so changing either alone fails.
 */
describe("UNGROUPED_CANDIDATE_FILTER agrees with candidateIsUngrouped", () => {
  /** Evaluates just the one form this constant is allowed to take. */
  const filterKeeps = (
    filter: Record<string, unknown>,
    carpoolId: string | null,
  ): boolean => {
    const entries = Object.entries(filter);
    expect(entries).toHaveLength(1);

    const [column, operand] = entries[0];
    expect(column).toBe("carpoolId");
    // Prisma reads a literal `null` on a nullable column as `IS NULL`. An
    // operator object would be a different rule and is not accepted here.
    expect(operand).toBeNull();

    return carpoolId === null;
  };

  it.each(GROUPS)("agrees on %s", (carpoolId) => {
    expect(filterKeeps(UNGROUPED_CANDIDATE_FILTER, carpoolId)).toBe(
      candidateIsUngrouped({ carpoolId }),
    );
  });

  it("excludes every group, which comparing to the reader's own did not", () => {
    expect(filterKeeps(UNGROUPED_CANDIDATE_FILTER, "someone-elses")).toBe(
      false,
    );
  });
});
