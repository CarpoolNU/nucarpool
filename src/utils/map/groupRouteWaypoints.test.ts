/**
 * The group route's pickup and dropoff ordering.
 *
 * Extracted from `pages/index.tsx` so that it could be tested at
 * all; the behaviour is unchanged. The constraint is what matters here — a
 * plain nearest neighbour over all four corners would happily drop a rider off
 * before collecting them, and nothing downstream would notice: Mapbox draws
 * whatever order it is handed.
 */

import { Role, Status } from "@prisma/client";
import type { PublicUser } from "../types";
import { planGroupWaypoints } from "./groupRouteWaypoints";

const buildRider = (
  id: string,
  start: [number, number],
  company: [number, number],
): PublicUser =>
  ({
    id,
    name: id,
    preferredName: id,
    pronouns: "",
    bio: "",
    role: Role.RIDER,
    status: Status.ACTIVE,
    seatAvail: 0,
    companyName: "Co",
    daysWorking: "1,1,1,1,1,0,0",
    startCoordLng: start[0],
    startCoordLat: start[1],
    companyCoordLng: company[0],
    companyCoordLat: company[1],
  }) as unknown as PublicUser;

const driver = {
  startCoordLng: 0,
  startCoordLat: 0,
  companyCoordLng: 10,
  companyCoordLat: 0,
};

/** Where each waypoint sits in the returned list. */
const indexOf = (
  waypoints: [number, number][],
  point: [number, number],
): number =>
  waypoints.findIndex(([lng, lat]) => lng === point[0] && lat === point[1]);

describe("planGroupWaypoints", () => {
  it("starts at the driver's home and ends at their workplace", () => {
    const waypoints = planGroupWaypoints(driver, []);

    expect(waypoints).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("visits both of a rider's corners", () => {
    const rider = buildRider("r1", [2, 0], [8, 0]);

    const waypoints = planGroupWaypoints(driver, [rider]);

    expect(waypoints).toEqual([
      [0, 0],
      [2, 0],
      [8, 0],
      [10, 0],
    ]);
  });

  describe("the constraint", () => {
    it("never drops a rider off before picking them up", () => {
      // The dropoff is nearer the driver's home than the pickup is, so an
      // unconstrained nearest neighbour would take it first.
      const rider = buildRider("r1", [9, 0], [1, 0]);

      const waypoints = planGroupWaypoints(driver, [rider]);

      expect(indexOf(waypoints, [9, 0])).toBeLessThan(
        indexOf(waypoints, [1, 0]),
      );
    });

    it("holds for every rider in a group of four", () => {
      const riders = [
        buildRider("r1", [9, 1], [1, 1]),
        buildRider("r2", [8, 2], [2, 2]),
        buildRider("r3", [7, 3], [3, 3]),
        buildRider("r4", [6, 4], [4, 4]),
      ];

      const waypoints = planGroupWaypoints(driver, riders);

      riders.forEach((rider) => {
        const pickup = indexOf(waypoints, [
          rider.startCoordLng,
          rider.startCoordLat,
        ]);
        const dropoff = indexOf(waypoints, [
          rider.companyCoordLng,
          rider.companyCoordLat,
        ]);

        expect(pickup).toBeGreaterThan(-1);
        expect(dropoff).toBeGreaterThan(-1);
        expect(pickup).toBeLessThan(dropoff);
      });
    });
  });

  describe("completeness", () => {
    it("visits every corner exactly once, plus the driver's two", () => {
      const riders = [
        buildRider("r1", [1, 1], [9, 1]),
        buildRider("r2", [2, 2], [8, 2]),
        buildRider("r3", [3, 3], [7, 3]),
      ];

      const waypoints = planGroupWaypoints(driver, riders);

      expect(waypoints).toHaveLength(2 + riders.length * 2);
      expect(new Set(waypoints.map(String)).size).toBe(waypoints.length);
    });

    it("terminates rather than looping when riders share a coordinate", () => {
      // Every candidate is at distance 0, so the sort is a tie throughout. The
      // loop drains its two sets regardless of which one it picks.
      const riders = [
        buildRider("r1", [0, 0], [0, 0]),
        buildRider("r2", [0, 0], [0, 0]),
      ];

      const waypoints = planGroupWaypoints(driver, riders);

      expect(waypoints).toHaveLength(6);
      expect(waypoints[waypoints.length - 1]).toEqual([10, 0]);
    });
  });

  describe("nearest-first ordering", () => {
    it("collects the closer rider first", () => {
      const near = buildRider("near", [1, 0], [9, 0]);
      const far = buildRider("far", [4, 0], [9.5, 0]);

      const waypoints = planGroupWaypoints(driver, [far, near]);

      expect(indexOf(waypoints, [1, 0])).toBeLessThan(
        indexOf(waypoints, [4, 0]),
      );
    });

    it("does not depend on the order the riders arrive in", () => {
      const a = buildRider("a", [1, 0], [9, 0]);
      const b = buildRider("b", [4, 0], [6, 0]);

      expect(planGroupWaypoints(driver, [a, b])).toEqual(
        planGroupWaypoints(driver, [b, a]),
      );
    });
  });
});
