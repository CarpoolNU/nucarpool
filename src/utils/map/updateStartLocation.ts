import { Role } from "@prisma/client";
import { PublicUser } from "../types";
import DriverStart from "../../../public/driver-start.png";
import RiderStart from "../../../public/rider-start.png";
import updatePointMarker, { PointMarkerSpec } from "./updatePointMarker";

/**
 * Another user's start pin: where they are travelling *from*.
 *
 * No `currentUserImages` and not `clickable`, both deliberately. See
 * `PointMarkerSpec` for what each absence means - in short, the viewer's own
 * start position is already marked by `updateUserLocation`'s pulsing dot, and
 * only destination pins open a popup.
 */
const START_MARKER: PointMarkerSpec = {
  idSegment: "start",
  otherUserImages: { driver: DriverStart.src, rider: RiderStart.src },
  labelFallback: "Start",
  clickable: false,
};

const updateStartLocation = (
  map: mapboxgl.Map,
  startLongitude: number,
  startLatitude: number,
  role: Role,
  userId: string,
  userData?: PublicUser,
  isCurrent: boolean = false,
  remove: boolean = false,
  customLabel?: string,
): void =>
  updatePointMarker(
    START_MARKER,
    map,
    startLongitude,
    startLatitude,
    role,
    userId,
    userData,
    isCurrent,
    remove,
    customLabel,
  );

export default updateStartLocation;
