import { PublicUser } from "../types";

/**
 * The order a group route visits everybody in.
 *
 * Lifted out of `onViewGroupRoute` in `pages/index.tsx` for the reason
 * given for `viewRoutePlan.ts`: this is the only part of the group
 * route with a right and a wrong answer, and until now no test could reach it
 * without rendering a 1300-line page against Mapbox, NextAuth and a dozen tRPC
 * queries. It is unchanged in behaviour — the extraction is what is needed
 * so that `groupRouteClick.ts` can be tested at all.
 *
 * The algorithm is a constraint-aware nearest neighbour. Start at the driver's
 * home; repeatedly go to the closest point that is *legal* right now; end at
 * the driver's workplace. A point is legal when it is a pickup for a rider not
 * yet collected, or a dropoff for one already in the car — so the ordering
 * cannot drop somebody off before collecting them, which a plain nearest
 * neighbour over all four corners would.
 *
 * It is a heuristic and not the shortest tour, which is fine: this draws a
 * preview, and Mapbox reorders nothing. A separate ticket covers combining the route
 * algorithms lives.
 */

/**
 * Straight-line distance in degrees, for **comparison only**.
 *
 * Not metres, and not corrected for latitude — a degree of longitude is about
 * 0.74 of a degree of latitude at Boston. It is kept as-is because every
 * candidate is measured from the same point by the same measure, and the result
 * is only ever used to pick the smallest. Anything relying on the magnitude
 * would need `distanceBetweenCoordinates`.
 */
const compareDistance = (
  [lng1, lat1]: [number, number],
  [lng2, lat2]: [number, number],
): number => Math.sqrt(Math.pow(lng2 - lng1, 2) + Math.pow(lat2 - lat1, 2));

type Candidate = {
  type: "pickup" | "dropoff";
  riderId: string;
  coordinates: [number, number];
  distance: number;
};

export const planGroupWaypoints = (
  driver: Pick<
    PublicUser,
    "startCoordLng" | "startCoordLat" | "companyCoordLng" | "companyCoordLat"
  >,
  riders: PublicUser[],
): [number, number][] => {
  const waypoints: [number, number][] = [
    [driver.startCoordLng, driver.startCoordLat],
  ];

  let currentLocation: [number, number] = [
    driver.startCoordLng,
    driver.startCoordLat,
  ];

  const remainingPickups = new Set(riders.map((rider) => rider.id));
  const pickedUpRiders = new Set<string>();
  const riderMap = new Map(riders.map((rider) => [rider.id, rider]));

  while (remainingPickups.size > 0 || pickedUpRiders.size > 0) {
    const candidatePoints: Candidate[] = [];

    remainingPickups.forEach((riderId) => {
      const rider = riderMap.get(riderId)!;
      const coordinates: [number, number] = [
        rider.startCoordLng,
        rider.startCoordLat,
      ];
      candidatePoints.push({
        type: "pickup",
        riderId,
        coordinates,
        distance: compareDistance(currentLocation, coordinates),
      });
    });

    // Dropoffs only for riders already in the car - this is the constraint.
    pickedUpRiders.forEach((riderId) => {
      const rider = riderMap.get(riderId)!;
      const coordinates: [number, number] = [
        rider.companyCoordLng,
        rider.companyCoordLat,
      ];
      candidatePoints.push({
        type: "dropoff",
        riderId,
        coordinates,
        distance: compareDistance(currentLocation, coordinates),
      });
    });

    candidatePoints.sort((a, b) => a.distance - b.distance);

    // The nearest candidate is always the valid one, so take it. Every
    // candidate above is already legal by construction. This replaced a loop
    // whose `if`/`else` branches were identical and both broke on the first
    // element, so it selected `candidatePoints[0]` while reading as a
    // constraint check.
    const chosenCandidate = candidatePoints[0];

    if (!chosenCandidate) break;

    waypoints.push(chosenCandidate.coordinates);
    currentLocation = chosenCandidate.coordinates;

    if (chosenCandidate.type === "pickup") {
      remainingPickups.delete(chosenCandidate.riderId);
      pickedUpRiders.add(chosenCandidate.riderId);
    } else {
      pickedUpRiders.delete(chosenCandidate.riderId);
    }
  }

  waypoints.push([driver.companyCoordLng, driver.companyCoordLat]);

  return waypoints;
};
