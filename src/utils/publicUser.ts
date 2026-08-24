import { Location, CarpoolSearch } from "@prisma/client";
import { PublicUser, User } from "./types";

/**
 * Converts the given ``User`` to a ``PublicUser``, as to hide sensitive data.
 *
 * @param user a rider or driver (merged User type from API).
 * @returns non-sensitive information about a user.
 */
export const convertToPublic = (user: User): PublicUser => {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    bio: user.bio,
    preferredName: user.preferredName,
    pronouns: user.pronouns,
    role: user.role,
    status: user.status,
    seatAvail: user.seatAvail,
    companyName: user.companyName,
    daysWorking: user.daysWorking,
    startTime: user.startTime,
    endTime: user.endTime,
    coopEndDate: user.coopEndDate,
    coopStartDate: user.coopStartDate,
    startAddress:
      user.startCity && user.startState
        ? `${user.startCity}, ${user.startState}`
        : user.startAddress || "Exact Location Unavailable",
    startCoordLng: user.startCoordLng,
    startCoordLat: user.startCoordLat,
    companyAddress: user.companyAddress,
    companyCoordLng: user.companyCoordLng,
    companyCoordLat: user.companyCoordLat,
    carpoolId: user.carpoolId,
  };
};

/**
 * Decimal places kept on a home coordinate that leaves the server for someone
 * other than a counterpart. Two places is a grid of roughly 1.1 km by 0.8 km at
 * Boston's latitude, so a point identifies a neighbourhood rather than a
 * doorstep - the same granularity as the "City, State" string `startAddress`
 * already exposes.
 */
const HOME_COORD_DECIMAL_PLACES = 2;

const coarsenHomeCoord = (coord: number) => {
  const factor = 10 ** HOME_COORD_DECIMAL_PLACES;
  return Math.round((coord + Number.EPSILON) * factor) / factor;
};

type CarpoolSearchWithRelations = CarpoolSearch & {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    bio: string;
    preferredName: string;
    pronouns: string;
  };
  homeLocation: Location | null;
  companyLocation: Location | null;
};

/**
 * Builds a `PublicUser` keeping the home coordinate at full precision.
 *
 * Only for a viewer who already has a relationship with this user - the same
 * carpool group, or an existing request between them. Everything else must use
 * `convertCarpoolSearchToPublic`.
 *
 * @param search an active CarpoolSearch record with user and location relations
 * @returns non-sensitive information about a user, home coordinate exact
 */
export const convertCarpoolSearchToPublicWithExactHome = (
  search: CarpoolSearchWithRelations,
): PublicUser => {
  return {
    id: search.user.id,
    name: search.user.name,
    email: search.user.email,
    image: search.user.image,
    bio: search.user.bio,
    preferredName: search.user.preferredName,
    pronouns: search.user.pronouns,
    role: search.role,
    status: search.status,
    seatAvail: search.seatsAvail,
    companyName: search.companyName,
    daysWorking: search.daysWorking,
    startTime: search.startTime,
    endTime: search.endTime,
    coopEndDate: search.endDate,
    coopStartDate: search.startDate,
    startAddress: search.homeLocation
      ? `${search.homeLocation.city}, ${search.homeLocation.state}`
      : "Exact Location Unavailable",
    startCoordLng: search.homeLocation?.coordLng ?? 0,
    startCoordLat: search.homeLocation?.coordLat ?? 0,
    companyAddress: search.companyLocation?.streetAddress ?? "",
    companyCoordLng: search.companyLocation?.coordLng ?? 0,
    companyCoordLat: search.companyLocation?.coordLat ?? 0,
    carpoolId: search.carpoolId,
  };
};

/**
 * Converts a CarpoolSearch record (with relations) to a PublicUser, with the
 * home coordinate reduced to neighbourhood precision.
 *
 * Home coordinates are the most sensitive data this app holds, and bulk list
 * responses - the map, recommendations, favorites - return up to 150 users to
 * any signed-in viewer. Metre-accurate coordinates in those payloads defeat the
 * address coarsening the product deliberately applies, because they can simply
 * be reverse-geocoded (SCRUM-226).
 *
 * **This is the default on purpose.** Use
 * `convertCarpoolSearchToPublicWithExactHome` only where the viewer already has
 * a relationship with the user - the same carpool group, or an existing request
 * between them - so that a caller which forgets to choose gets the safe result.
 *
 * @param search an active CarpoolSearch record with user and location relations
 * @returns non-sensitive information about a user, home coordinate coarsened
 */
export const convertCarpoolSearchToPublic = (
  search: CarpoolSearchWithRelations,
): PublicUser => {
  const publicUser = convertCarpoolSearchToPublicWithExactHome(search);

  return {
    ...publicUser,
    startCoordLng: coarsenHomeCoord(publicUser.startCoordLng),
    startCoordLat: coarsenHomeCoord(publicUser.startCoordLat),
  };
};

export const roundCoord = (coord: number) => {
  return Math.round((coord + Number.EPSILON) * 100000) / 100000;
};
