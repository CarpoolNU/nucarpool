import mapboxgl from "mapbox-gl";
import { CarpoolAddress, GeoJsonUsers, PublicUser, User } from "../types";
import { viewRoute } from "./viewRoute";
import clearOtherUserMarkers from "./clearOtherUserMarkers";
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
 * SCRUM-379's `DestinationMarkerRef` and `removeDestinationMarker` **were
 * here, and SCRUM-391 removed them.**
 *
 * They existed because pin removal was keyed by identity: a pin is a named
 * layer, so the only way to take one off was to have remembered whose it was.
 * One pin at a time was the model, and it worked for this handler - but
 * `onViewGroupRoute` adds a pin per group member and remembered none, so its
 * pins were never removed by anything. Extending the ref to a set would have
 * kept the bookkeeping, and a bookkeeping slip here shows up as a stray pin
 * nobody traces back.
 *
 * `clearOtherUserMarkers` asks the map which layers exist instead, which cannot
 * forget one. With it running at the top of this function there is no
 * remembered pin left to remove, so the ref, the remover, the page's
 * `destinationMarker` and `ViewRoutePlan.removesDestinationMarkerFor` all went
 * together.
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
  // each member, and this handler's own pin from the last click. SCRUM-391:
  // before the sweep, only the rider *start* markers were cleared here, so the
  // group's destination pins stayed behind an individual route with nothing
  // explaining them.
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
