/**
 * The seat-count-on-role-change decision.
 *
 * The defect this pins is not a wrong value but a wrong *occasion*: the rule
 * was correct for a role switch and ran on form population as well, so opening
 * `/profile` rewrote a full driver's `seats_avail` from `0` to `1` and the next
 * save persisted it. The assertion that matters is therefore the
 * `previousRole === nextRole` one — everything else here was already true of
 * the effect this replaced.
 */

import { Role } from "@prisma/client";
import { MAX_SEATS_AVAILABLE } from "../carpoolSeats";
import { DEFAULT_DRIVER_SEATS, seatAvailOnRoleChange } from "./roleSeatDefault";

const ROLES = [Role.VIEWER, Role.RIDER, Role.DRIVER];

describe("seatAvailOnRoleChange", () => {
  describe("populating the form is not a role change", () => {
    // The regression itself. `reset(...)` restores the stored role, so the
    // "previous" and "next" role are the same value; whatever seat count came
    // out of the database has to survive it.
    it.each(ROLES)("leaves %s alone at every in-range seat count", (role) => {
      for (let seats = 0; seats <= MAX_SEATS_AVAILABLE; seats++) {
        expect(seatAvailOnRoleChange(role, role, seats)).toBeNull();
      }
    });

    it("leaves a full driver at 0 rather than inventing a seat", () => {
      expect(seatAvailOnRoleChange(Role.DRIVER, Role.DRIVER, 0)).toBeNull();
    });

    it("leaves an undefined count alone, having no transition to act on", () => {
      expect(
        seatAvailOnRoleChange(Role.DRIVER, Role.DRIVER, undefined),
      ).toBeNull();
    });
  });

  describe("becoming a driver", () => {
    it.each([Role.RIDER, Role.VIEWER])(
      "gives a %s switching to DRIVER a usable starting count",
      (previousRole) => {
        expect(seatAvailOnRoleChange(previousRole, Role.DRIVER, 0)).toBe(
          DEFAULT_DRIVER_SEATS,
        );
      },
    );

    it("starts a driver above zero, because onboarding refuses zero", () => {
      // `setup.tsx`'s step-1 guard rejects a DRIVER with `seatAvail <= 0`, so
      // a default of `0` would strand a new driver on the first step.
      expect(DEFAULT_DRIVER_SEATS).toBeGreaterThan(0);
      expect(DEFAULT_DRIVER_SEATS).toBeLessThanOrEqual(MAX_SEATS_AVAILABLE);
    });

    it("treats a missing count as needing a default", () => {
      expect(seatAvailOnRoleChange(Role.RIDER, Role.DRIVER, undefined)).toBe(
        DEFAULT_DRIVER_SEATS,
      );
    });

    it("keeps a count the user already entered", () => {
      expect(seatAvailOnRoleChange(Role.RIDER, Role.DRIVER, 4)).toBeNull();
    });

    it("replaces an out-of-range negative rather than keeping it", () => {
      // Not reachable from the input (`min="0"`), but a stored residue can be
      // negative - SCRUM-348 - and a driver switching role should not carry it.
      expect(seatAvailOnRoleChange(Role.RIDER, Role.DRIVER, -1)).toBe(
        DEFAULT_DRIVER_SEATS,
      );
    });
  });

  describe("ceasing to be a driver", () => {
    it.each([Role.RIDER, Role.VIEWER])(
      "clears a driver's seats on the switch to %s",
      (nextRole) => {
        expect(seatAvailOnRoleChange(Role.DRIVER, nextRole, 3)).toBe(0);
      },
    );

    it("clears a viewer switching to rider, so a stale count cannot persist", () => {
      expect(seatAvailOnRoleChange(Role.VIEWER, Role.RIDER, 2)).toBe(0);
    });

    it("reports no change when the count is already zero", () => {
      // `null` rather than `0` so a no-op never writes to the form at all.
      expect(seatAvailOnRoleChange(Role.DRIVER, Role.RIDER, 0)).toBeNull();
    });
  });

  describe("across every transition", () => {
    it("never returns a value outside [0, MAX_SEATS_AVAILABLE]", () => {
      const seatCounts = [undefined, -1, 0, 1, 3, MAX_SEATS_AVAILABLE, 99];

      for (const previousRole of ROLES) {
        for (const nextRole of ROLES) {
          for (const seats of seatCounts) {
            const result = seatAvailOnRoleChange(previousRole, nextRole, seats);
            if (result === null) continue;

            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(MAX_SEATS_AVAILABLE);
          }
        }
      }
    });

    it("only ever changes seats when the role actually changed", () => {
      for (const role of ROLES) {
        for (const seats of [undefined, -1, 0, 1, 6]) {
          expect(seatAvailOnRoleChange(role, role, seats)).toBeNull();
        }
      }
    });
  });
});
