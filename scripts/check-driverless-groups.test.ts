import { Role } from "@prisma/client";
import { findDriverlessGroups } from "./check-driverless-groups";

/**
 * The detection half of the SCRUM-289 check, tested without a database.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

const group = (id: string, members: [string, Role][]) => ({
  id,
  members: members.map(([userId, role]) => ({ userId, role })),
});

describe("findDriverlessGroups", () => {
  it("reports a group whose members include no driver", () => {
    const { driverless, empty } = findDriverlessGroups([
      group("healthy", [
        ["d", Role.DRIVER],
        ["r1", Role.RIDER],
      ]),
      group("stranded", [
        ["d", Role.RIDER],
        ["r1", Role.RIDER],
        ["r2", Role.RIDER],
      ]),
    ]);

    expect(driverless.map((g) => g.id)).toEqual(["stranded"]);
    expect(empty).toEqual([]);
  });

  it("separates an empty group from a stranded one", () => {
    const { driverless, empty } = findDriverlessGroups([
      group("leaked", []),
      group("stranded", [["r1", Role.RIDER]]),
    ]);

    // Different problems: one has people stuck in it, the other affects nobody.
    expect(driverless.map((g) => g.id)).toEqual(["stranded"]);
    expect(empty.map((g) => g.id)).toEqual(["leaked"]);
  });

  it("treats a VIEWER member as no driver", () => {
    // The role a driver is most likely to switch to by accident, and it is not
    // a driver - so the group is just as stuck as with a RIDER.
    const { driverless } = findDriverlessGroups([
      group("viewer-only", [
        ["d", Role.VIEWER],
        ["r1", Role.RIDER],
      ]),
    ]);

    expect(driverless.map((g) => g.id)).toEqual(["viewer-only"]);
  });

  it("reports nothing when every group has a driver", () => {
    expect(
      findDriverlessGroups([
        group("a", [
          ["d1", Role.DRIVER],
          ["r1", Role.RIDER],
        ]),
        group("b", [["d2", Role.DRIVER]]),
      ]),
    ).toEqual({ driverless: [], empty: [] });
  });

  it("leaves a group with two drivers alone", () => {
    // A separate invariant (SCRUM-291). Every management path still works, so
    // folding it in here would bury the groups that are actually stuck.
    const { driverless, empty } = findDriverlessGroups([
      group("two-drivers", [
        ["d1", Role.DRIVER],
        ["d2", Role.DRIVER],
      ]),
    ]);

    expect(driverless).toEqual([]);
    expect(empty).toEqual([]);
  });
});
