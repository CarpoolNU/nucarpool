import { CarpoolAddress, GeoJsonUsers, PublicUser, User } from "../types";
import { viewRoute } from "./viewRoute";
import clearOtherUserMarkers from "./clearOtherUserMarkers";
import updateCompanyLocation from "./updateCompanyLocation";
import updateUserLocation from "./updateUserLocation";
import { isValidCoordinates } from "./coordinates";
import { planViewRoute } from "./viewRoutePlan";

/**
 * The **View Route** click handler, lifted out of `pages/index.tsx` so it is
 * testable without rendering a 1300-line page against Mapbox, NextAuth and a
 * dozen tRPC queries.
 *
 * `onViewRouteClick` is now a `useCallback` that forwards to this. The move is
 * deliberate rather than tidying: a branch that can never be true here would
 * mean the route is never drawn for anyone the map is not already plotting,
 * and nothing short of extraction can catch that. `planViewRoute` makes the
 * *decision* testable; this makes "and then the route is actually drawn"
 * testable, which is the other half.
 *
 * Everything this needs arrives as an argument rather than through closure, so
 * the only imports are the map helpers - which a test replaces with
 * `jest.mock`. It stays a plain function rather than a hook: it runs entirely
 * in response to a click and holds no state of its own.
 */

/**
 * `clearOtherUserMarkers`, called at the top of this handler, removes every
 * pin by asking the map which layers exist rather than tracking identity by
 * reference.
 *
 * A single remembered ref works for one pin at a time, which is this
 * handler's own model - but `onViewGroupRoute` adds a pin per group member,
 * and a set of individually tracked refs is bookkeeping that a slip turns
 * into a stray pin nobody traces back. Asking the map instead cannot forget
 * one, for either caller.
 */

export const runViewRouteClick = ({
  user,
  clickedUser,
  map,
  geoJsonUsers,
  selectedUserId,
  startAddressSelected,
  companyAddressSelected,
  isMobile,
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
  setOtherUser: (value: PublicUser | null) => void;
  setPoints: (value: [number, number][]) => void;
}): void => {
  // Take off every pin the previous view left - the group preview's markers for
  // each member, and this handler's own pin from the last click - before
  // drawing anything new, so no destination pin sits behind an individual
  // route with nothing explaining it.
  if (map) {
    clearOtherUserMarkers(map);
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
