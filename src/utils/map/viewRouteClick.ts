import mapboxgl from "mapbox-gl";
import { CarpoolAddress, GeoJsonUsers, PublicUser, User } from "../types";
import { viewRoute } from "./viewRoute";
import clearRiderStartMarkers from "./clearRiderStartMarkers";
import updateCompanyLocation from "./updateCompanyLocation";
import updateUserLocation from "./updateUserLocation";
import { isValidCoordinates } from "./coordinates";
import { planViewRoute } from "./viewRoutePlan";

/**
 * The **View Route** click handler, lifted out of `pages/index.tsx`.
 *
 * `onViewRouteClick` is now a `useCallback` that forwards to this. The move is
 * part of SCRUM-379 rather than tidying alongside it: the bug fixed there - a
 * branch that could never be true, so the route was never drawn for anyone the
 * map was not already plotting - lived for ten months because nothing could
 * execute this code without rendering a 1300-line page against Mapbox,
 * NextAuth and a dozen tRPC queries. `planViewRoute` makes the *decision*
 * testable; this makes "and then the route is actually drawn" testable, which
 * is the half that was missing.
 *
 * Everything the page used to read from its closure arrives as an argument, so
 * the only imports are the map helpers - which a test replaces with
 * `jest.mock`. It stays a plain function rather than a hook: it runs entirely
 * in response to a click and holds no state of its own.
 */

/**
 * The one destination pin this module has put on the map, remembered so that it
 * can be taken off again.
 *
 * A `ref` and not React state, and that is the fix to the second half of
 * SCRUM-379. The page used to hold this in `tempOtherUser` /
 * `tempOtherUserMarkerActive`, and **both the `sidebarType` effect and the
 * initial-route effect listed them as dependencies while also resetting them in
 * their bodies.** An effect that depends on state it writes re-runs itself;
 * that pair was a live loop held shut only by the fact that the state could
 * never change, because the only code that set it was the unreachable branch.
 * Fixing the branch alone would have released it.
 *
 * Nothing renders from this value - it exists purely to name a Mapbox layer for
 * removal - so a ref is the honest container, and a ref cannot appear in a
 * dependency array at all. The loop is gone structurally rather than by
 * arranging the arrays carefully.
 *
 * Typed as the minimal shape rather than `MutableRefObject` so a test can pass
 * `{ current: null }`.
 */
export type DestinationMarkerRef = { current: PublicUser | null };

/**
 * Takes the remembered destination pin off the map, if there is one.
 *
 * `updateCompanyLocation` with `remove: true` is how a pin comes off: it owns
 * the `other-user-<id>-company-*` source, layer, text layer and image, and
 * `clearMarkers` in `viewRoute.ts` clears none of those.
 *
 * Leaves the ref alone when there is no map, matching the old
 * `if (... && mapState)` guard - the pin is still on a map that exists
 * somewhere, and forgetting it would strand the layer permanently.
 */
export const removeDestinationMarker = (
  map: mapboxgl.Map | undefined,
  destinationMarker: DestinationMarkerRef,
): void => {
  const marked = destinationMarker.current;

  if (!marked || !map) {
    return;
  }

  updateCompanyLocation(
    map,
    marked.companyCoordLng,
    marked.companyCoordLat,
    marked.role,
    marked.id,
    marked,
    false,
    true,
  );

  destinationMarker.current = null;
};

export const runViewRouteClick = ({
  user,
  clickedUser,
  map,
  geoJsonUsers,
  selectedUserId,
  startAddressSelected,
  companyAddressSelected,
  isMobile,
  destinationMarker,
  setOtherUser,
  setPoints,
}: {
  user: User;
  clickedUser: PublicUser;
  map: mapboxgl.Map | undefined;
  geoJsonUsers: GeoJsonUsers | undefined;
  selectedUserId: string | null;
  startAddressSelected: CarpoolAddress;
  companyAddressSelected: CarpoolAddress;
  isMobile: boolean;
  destinationMarker: DestinationMarkerRef;
  setOtherUser: (value: PublicUser | null) => void;
  setPoints: (value: [number, number][]) => void;
}): void => {
  // clear rider start markers from group route when viewing individual routes
  if (map) {
    clearRiderStartMarkers(map);
  }

  // add null checks for required objects
  if (!geoJsonUsers || !map || !user || !clickedUser) {
    console.error("Required objects not available for route viewing");
    return;
  }

  // add null check for geoJsonUsers.features
  //
  // Computed before the coordinate guard below purely so the plan can be built
  // in one place. It reads nothing but `geoJsonUsers`, which the check above
  // has already established, and it has no side effects - so the order the
  // page's side effects happen in is unchanged.
  const isClickedUserOnMap =
    geoJsonUsers.features?.some((f) => f.properties?.id === clickedUser.id) ??
    false;

  const plan = planViewRoute({
    clickedUserId: clickedUser.id,
    selectedUserId,
    isClickedUserOnMap,
    markedDestinationUserId: destinationMarker.current?.id ?? null,
  });

  if (plan.selectsClickedUser) {
    setOtherUser(clickedUser);
  }

  // validate user and clickedUser have required coordinate properties
  if (
    !isValidCoordinates(user.startCoordLng, user.startCoordLat) ||
    !isValidCoordinates(user.companyCoordLng, user.companyCoordLat) ||
    !isValidCoordinates(clickedUser.startCoordLng, clickedUser.startCoordLat) ||
    !isValidCoordinates(
      clickedUser.companyCoordLng,
      clickedUser.companyCoordLat,
    )
  ) {
    console.error("Invalid user coordinates for route viewing");
    return;
  }

  const isViewerAddressSelected =
    companyAddressSelected.place_name !== "" &&
    startAddressSelected.place_name !== "";
  const companyCord: number[] = companyAddressSelected.center;
  const startCord: number[] = startAddressSelected.center;
  const userStartLng = isViewerAddressSelected
    ? startCord[0]
    : user.startCoordLng;
  const userStartLat = isViewerAddressSelected
    ? startCord[1]
    : user.startCoordLat;
  const userCompanyLng = isViewerAddressSelected
    ? companyCord[0]
    : user.companyCoordLng;
  const userCompanyLat = isViewerAddressSelected
    ? companyCord[1]
    : user.companyCoordLat;
  const userCoord =
    !isViewerAddressSelected && user.role === "VIEWER"
      ? undefined
      : {
          startLat: userStartLat,
          startLng: userStartLng,
          endLat: userCompanyLat,
          endLng: userCompanyLng,
        };

  if (user.role !== "VIEWER") {
    updateUserLocation(map, userStartLng, userStartLat);
    updateCompanyLocation(
      map,
      userCompanyLng,
      userCompanyLat,
      user.role,
      user.id,
      user,
      true,
    );
  }

  if (plan.removesDestinationMarkerFor) {
    removeDestinationMarker(map, destinationMarker);
  }

  if (plan.addsDestinationMarker) {
    updateCompanyLocation(
      map,
      clickedUser.companyCoordLng,
      clickedUser.companyCoordLat,
      clickedUser.role,
      clickedUser.id,
      clickedUser,
      false,
      false,
    );
    // Request-context pins are remembered too, which they were not before.
    // Nothing tracked them, so switching between two conversations left the
    // first person's pin on the map with no route attached to it, and changing
    // tab left it there for good. One pin at a time is the model either way.
    destinationMarker.current = clickedUser;
  }

  const viewProps = {
    user,
    otherUser: clickedUser,
    map,
    userCoord,
    isMobile,
  };

  if (user.role === "RIDER") {
    setPoints([
      [clickedUser.startCoordLng, clickedUser.startCoordLat],
      [userStartLng, userStartLat],
      [userCompanyLng, userCompanyLat],
      [clickedUser.companyCoordLng, clickedUser.companyCoordLat],
    ]);
  } else if (
    user.role === "DRIVER" ||
    isViewerAddressSelected ||
    !!selectedUserId
  ) {
    setPoints([
      [userStartLng, userStartLat],
      [clickedUser.startCoordLng, clickedUser.startCoordLat],
      [clickedUser.companyCoordLng, clickedUser.companyCoordLat],
      [userCompanyLng, userCompanyLat],
    ]);
  } else {
    setPoints([
      [clickedUser.startCoordLng, clickedUser.startCoordLat],
      [clickedUser.companyCoordLng, clickedUser.companyCoordLat],
    ]);
  }

  viewRoute(viewProps);
};
