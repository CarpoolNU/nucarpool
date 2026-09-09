import mapboxgl from "mapbox-gl";
import { PublicUser, User } from "../types";
import { clearDirections, clearMarkers } from "./viewRoute";
import clearOtherUserMarkers from "./clearOtherUserMarkers";
import updateCompanyLocation from "./updateCompanyLocation";
import updateStartLocation from "./updateStartLocation";
import updateUserLocation from "./updateUserLocation";
import { planGroupWaypoints } from "./groupRouteWaypoints";

/**
 * **Preview Group Route**, lifted out of `pages/index.tsx`.
 *
 * The extraction is SCRUM-391's, and for the reason SCRUM-379 gives for
 * `viewRouteClick.ts`: the defect fixed here — every group member's destination
 * pin staying on the map for the rest of the session — was unreachable by any
 * test while the handler was a closure inside a 1300-line page. A pin that is
 * never removed is invisible to review and invisible to a suite that cannot run
 * the code.
 *
 * The fix itself is one line: `clearOtherUserMarkers` at the top, before this
 * handler draws anything. See that module for why a sweep replaced the
 * remembered-pin bookkeeping rather than extending it.
 *
 * **Order matters and is the acceptance criterion most easily broken.** The
 * sweep has to run before the pins this handler adds, never after — clearing
 * the markers it just drew would trade a stale overlay for an empty one.
 * `groupRouteClick.test.ts` asserts the ordering directly rather than trusting
 * it to reading.
 */
export const runViewGroupRoute = ({
  user,
  driver,
  riders,
  map,
  setPoints,
}: {
  user: User;
  driver: PublicUser;
  riders: PublicUser[];
  map: mapboxgl.Map | undefined;
  setPoints: (value: [number, number][]) => void;
}): void => {
  if (!map || !user) {
    console.error("Map or user not available for group route viewing");
    return;
  }

  // Clear the previous preview before drawing this one. `clearOtherUserMarkers`
  // is the SCRUM-391 fix: it takes off every group member's pin from the last
  // preview, and the individual View Route pin, both of which used to survive.
  clearDirections(map);
  clearMarkers(map);
  clearOtherUserMarkers(map);

  setPoints(planGroupWaypoints(driver, riders));

  // The viewer's own markers, which are `current-user-*` and so untouched by
  // the sweep above.
  if (user.role !== "VIEWER") {
    updateUserLocation(map, user.startCoordLng, user.startCoordLat);
    updateCompanyLocation(
      map,
      user.companyCoordLng,
      user.companyCoordLat,
      user.role,
      user.id,
      user,
      true,
    );
  }

  // Every other member gets a labelled start marker and destination pin. The
  // current user is skipped in both loops - they already have theirs above, in
  // the `current-user-*` colours that mark them as you rather than as somebody
  // you are looking at.
  const members: { member: PublicUser; label: string }[] = [];

  if (driver.id !== user.id) {
    members.push({
      member: driver,
      label: driver.preferredName || driver.name || "Driver",
    });
  }

  riders.forEach((rider, index) => {
    if (rider.id !== user.id) {
      members.push({
        member: rider,
        label: rider.preferredName || rider.name || `Rider ${index + 1}`,
      });
    }
  });

  members.forEach(({ member, label }) => {
    updateStartLocation(
      map,
      member.startCoordLng,
      member.startCoordLat,
      member.role,
      member.id,
      member,
      false,
      false,
      `${label} Start`,
    );

    updateCompanyLocation(
      map,
      member.companyCoordLng,
      member.companyCoordLat,
      member.role,
      member.id,
      member,
      false,
      false,
      `${label} Dest.`,
    );
  });

  // Fit to everyone in the group, including the current user's own corners -
  // `driver` and `riders` between them cover every member.
  const allCoords: [number, number][] = [
    [driver.startCoordLng, driver.startCoordLat],
    [driver.companyCoordLng, driver.companyCoordLat],
    ...riders.map((rider): [number, number] => [
      rider.startCoordLng,
      rider.startCoordLat,
    ]),
    ...riders.map((rider): [number, number] => [
      rider.companyCoordLng,
      rider.companyCoordLat,
    ]),
  ];

  const bounds = new mapboxgl.LngLatBounds();
  allCoords.forEach((coord) => {
    bounds.extend(coord);
  });

  map.fitBounds(bounds, { padding: 50 });
};
