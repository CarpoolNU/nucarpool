import { Role } from "@prisma/client";
import { findGroupAnomalies } from "./check-driverless-groups";

/**
 * The detection half of the group-integrity check, tested without a database.
 * Driverless and empty groups come from a driver changing role or leaving;
 * driver-only groups from the overwritten-membership bug that left them behind.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

const group = (id: string, members: [string, Role][]) => ({
  id,
  members: members.map(([userId, role]) => ({ userId, role })),
});

describe("findGroupAnomalies", () => {
  it("reports a group whose members include no driver", () => {
    const { driverless, empty } = findGroupAnomalies([
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
    const { driverless, empty } = findGroupAnomalies([
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
    const { driverless } = findGroupAnomalies([
      group("viewer-only", [
        ["d", Role.VIEWER],
        ["r1", Role.RIDER],
      ]),
    ]);

    expect(driverless.map((g) => g.id)).toEqual(["viewer-only"]);
  });

  it("reports nothing when every group has a driver and a passenger", () => {
    expect(
      findGroupAnomalies([
        group("a", [
          ["d1", Role.DRIVER],
          ["r1", Role.RIDER],
        ]),
        group("b", [
          ["d2", Role.DRIVER],
          ["r2", Role.RIDER],
        ]),
      ]),
    ).toEqual({ driverless: [], empty: [], solo: [] });
  });

  it("leaves a group with two drivers alone", () => {
    // A separate invariant. Every management path still works, so
    // folding it in here would bury the groups that are actually stuck.
    const { driverless, empty, solo } = findGroupAnomalies([
      group("two-drivers", [
        ["d1", Role.DRIVER],
        ["d2", Role.DRIVER],
      ]),
    ]);

    expect(driverless).toEqual([]);
    expect(empty).toEqual([]);
    expect(solo).toEqual([]);
  });

  it("reports a group holding only its driver", () => {
    // Failure scenario A: the rider's membership was overwritten by a join
    // elsewhere, and nothing dissolved what they left behind.
    const { solo, driverless, empty } = findGroupAnomalies([
      group("orphaned", [["d1", Role.DRIVER]]),
      group("healthy", [
        ["d2", Role.DRIVER],
        ["r1", Role.RIDER],
      ]),
    ]);

    expect(solo.map((g) => g.id)).toEqual(["orphaned"]);
    expect(driverless).toEqual([]);
    expect(empty).toEqual([]);
  });

  it("calls a group holding one lone rider driverless, not solo", () => {
    // Both labels fit, and the categories are ordered so the more serious one
    // wins: a lone rider is stuck, not merely orphaned.
    const { solo, driverless } = findGroupAnomalies([
      group("lone-rider", [["r1", Role.RIDER]]),
    ]);

    expect(driverless.map((g) => g.id)).toEqual(["lone-rider"]);
    expect(solo).toEqual([]);
  });
});
