import BlueEnd from "../../../public/user-dest.png";
import BlueDriverEnd from "../../../public/user-dest-driver.png";
import RedDriverEnd from "../../../public/driver-dest.png";
import OrangeRiderEnd from "../../../public/rider-dest.png";
import { Role } from "@prisma/client";
import { PublicUser } from "../types";
import updatePointMarker, { PointMarkerSpec } from "./updatePointMarker";

/**
 * A destination pin: where somebody is travelling *to*.
 *
 * Unlike the start pin this one is drawn for the viewer as well, in the blue
 * pair that marks a pin as theirs, and another user's is clickable - it is the
 * pin that opens their popup.
 */
const COMPANY_MARKER: PointMarkerSpec = {
  idSegment: "company",
  otherUserImages: { driver: RedDriverEnd.src, rider: OrangeRiderEnd.src },
  currentUserImages: { driver: BlueDriverEnd.src, rider: BlueEnd.src },
  labelFallback: "Destination",
  clickable: true,
};

const updateCompanyLocation = (
  map: mapboxgl.Map,
  companyLongitude: number,
  companyLatitude: number,
  role: Role,
  userId: string,
  userData?: PublicUser,
  isCurrent: boolean = false,
  remove: boolean = false,
  customLabel?: string,
): void =>
  updatePointMarker(
    COMPANY_MARKER,
    map,
    companyLongitude,
    companyLatitude,
    role,
    userId,
    userData,
    isCurrent,
    remove,
    customLabel,
  );

export default updateCompanyLocation;
