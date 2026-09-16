import { Role } from "@prisma/client";
import {
  decideDissolution,
  parseArgs,
  sortById,
  summariseDissolution,
} from "./repair-seat-residue";

/**
 * The script updates a column and deletes a row, so the argument parser is the
 * last thing standing between a typo and a write nobody intended. These pin the
 * same two properties as `cleanup-orphan-locations.test.ts`: writing is opt-in,
 * and anything unrecognised stops the run rather than being ignored.
 *
 * The seat selection and repair values are covered in
 * `src/server/db/seatIntegrity.test.ts`, and which groups count as driverless
 * or empty in `check-driverless-groups.test.ts` — both are where those halves
 * live. What is tested here is the part this script owns: the two numbers the
 * dry run has to state, the order it states them in, and the re-check that
 * decides whether a planned dissolve still happens. Importing this module is
 * safe because it only calls main() when run directly.
 */

const members = (...roles: Role[]) =>
  roles.map((role, i) => ({ userId: `u${i}`, role }));

const group = (id: string, ...roles: Role[]) => ({
  id,
  members: members(...roles),
});

describe("repair-seat-residue argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("only writes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // An explicit --dry-run after --apply wins, so the more cautious of two
    // conflicting flags is the one that takes effect.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    // `--aply` must not silently become a dry run that the operator reads as
    // "it wrote nothing, so there was nothing to repair".
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["extra"])).toThrow(/unknown argument/);
  });

  it("accepts a raised cap", () => {
    expect(parseArgs(["--apply", "--max", "2000"])).toEqual({
      apply: true,
      max: 2000,
    });
  });

  it("rejects a cap that is not a positive integer", () => {
    for (const bad of ["abc", "0", "-1", "1.5", ""]) {
      expect(() => parseArgs(["--max", bad])).toThrow(/positive integer/);
    }
    expect(() => parseArgs(["--max"])).toThrow(/positive integer/);
  });
});

describe("summariseDissolution", () => {
  it("counts groups and memberships as two separate numbers", () => {
    // 14 pairs and one group of five is the production shape (SCRUM-406):
    // approving "15 groups" is not the same as approving "33 people moved".
    expect(
      summariseDissolution([
        group("a", Role.RIDER, Role.RIDER),
        group("b", Role.RIDER, Role.VIEWER),
        group(
          "c",
          Role.RIDER,
          Role.RIDER,
          Role.VIEWER,
          Role.RIDER,
          Role.VIEWER,
        ),
      ]),
    ).toEqual({ groupCount: 3, membershipCount: 9 });
  });

  it("reports zero for both when there is nothing to dissolve", () => {
    expect(summariseDissolution([])).toEqual({
      groupCount: 0,
      membershipCount: 0,
    });
  });

  it("counts a RIDER-only and a RIDER/VIEWER group alike", () => {
    // Composition does not change the repair: neither shape contains a driver,
    // and nothing is promoted, so both are dissolved identically.
    const riderOnly = summariseDissolution([
      group("a", Role.RIDER, Role.RIDER),
    ]);
    const mixed = summariseDissolution([group("b", Role.RIDER, Role.VIEWER)]);
    expect(riderOnly).toEqual(mixed);
  });
});

describe("sortById", () => {
  it("puts candidates in a stable order regardless of query order", () => {
    // `findMany` has no guaranteed order, so without this two dry runs against
    // unchanged data can print the same plan as two different-looking lists.
    const groups = [group("c"), group("a"), group("b")];
    expect(sortById(groups).map((g) => g.id)).toEqual(["a", "b", "c"]);
    expect(sortById([...groups].reverse()).map((g) => g.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not mutate its input", () => {
    const groups = [group("c"), group("a")];
    sortById(groups);
    expect(groups.map((g) => g.id)).toEqual(["c", "a"]);
  });
});

describe("decideDissolution", () => {
  it("dissolves a group of riders", () => {
    expect(decideDissolution(members(Role.RIDER, Role.RIDER))).toEqual({
      action: "dissolve",
    });
  });

  it("dissolves a mixed RIDER/VIEWER group", () => {
    expect(decideDissolution(members(Role.RIDER, Role.VIEWER))).toEqual({
      action: "dissolve",
    });
  });

  it("dissolves a group of viewers", () => {
    expect(decideDissolution(members(Role.VIEWER, Role.VIEWER))).toEqual({
      action: "dissolve",
    });
  });

  it("dissolves a multi-member group", () => {
    expect(
      decideDissolution(
        members(Role.RIDER, Role.RIDER, Role.VIEWER, Role.RIDER, Role.VIEWER),
      ),
    ).toEqual({ action: "dissolve" });
  });

  it("still deletes a group that lost its last member after planning", () => {
    // It is the `empty` defect by the time it is reached, and the row is leaked
    // either way — so the dissolve is still the right outcome. This is also the
    // state a re-run sees, which is what makes the repair idempotent: the
    // second run finds no driverless group at all.
    expect(decideDissolution([])).toEqual({ action: "dissolve" });
  });

  it("skips a group that gained a DRIVER after the plan was built", () => {
    // Somebody joined it or changed role into it between the read and the
    // write. It is no longer the defect this repairs, so it is not dissolved
    // out from under them.
    expect(decideDissolution(members(Role.RIDER, Role.DRIVER))).toMatchObject({
      action: "skip",
    });
  });

  it("skips a group that is only a DRIVER", () => {
    expect(decideDissolution(members(Role.DRIVER))).toMatchObject({
      action: "skip",
    });
  });
});
