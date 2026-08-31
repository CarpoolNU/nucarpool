import { Location, CarpoolSearch } from "@prisma/client";
import { PublicUser } from "./types";

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

/** The user columns every `PublicUser` is built from. Deliberately no email. */
type PublicUserFields = {
  id: string;
  name: string | null;
  image: string | null;
  bio: string;
  preferredName: string;
  pronouns: string;
};

type CarpoolSearchWithRelations = CarpoolSearch & {
  user: PublicUserFields;
  homeLocation: Location | null;
  companyLocation: Location | null;
};

/**
 * The same row plus the address, for the converter allowed to disclose it.
 *
 * Kept as a separate type so the coarsened converter cannot be handed an email
 * to leak by accident: a caller that selects one has to reach for the exact-home
 * converter deliberately.
 */
type CarpoolSearchWithContact = CarpoolSearch & {
  user: PublicUserFields & { email: string | null };
  homeLocation: Location | null;
  companyLocation: Location | null;
};

/**
 * Everything in a `PublicUser` that does not depend on who is looking, with the
 * home coordinate still exact. Both converters below start here and then differ
 * only in what they are allowed to disclose.
 */
const buildPublicUser = (search: CarpoolSearchWithRelations): PublicUser => ({
  id: search.user.id,
  name: search.user.name,
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
});

/**
 * Builds a `PublicUser` keeping the home coordinate at full precision, and
 * including the email address.
 *
 * Only for a viewer who already has a relationship with this user - the same
 * carpool group, or an existing request between them. Everything else must use
 * `convertCarpoolSearchToPublic`.
 *
 * Both disclosures travel together because the same rule governs them. It was
 * established for coordinates first; `email` sat in the same struct and was not
 * revisited until later.
 *
 * @param search an active CarpoolSearch record with user and location relations
 * @returns a user's details, home coordinate exact and email included
 */
export const convertCarpoolSearchToPublicWithExactHome = (
  search: CarpoolSearchWithContact,
): PublicUser => {
  return {
    ...buildPublicUser(search),
    email: search.user.email,
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
 * be reverse-geocoded.
 *
 * The email address is omitted for the same reason. These payloads
 * carried every active user's Northeastern address to any signed-in viewer -
 * up to 150 per map request, unbounded for favorites, and the whole ranked set
 * for a VIEWER - on screens that never displayed it. Two consumers needed it and
 * both have a relationship with the user, so both use the converter above.
 *
 * **This is the default on purpose.** Use
 * `convertCarpoolSearchToPublicWithExactHome` only where the viewer already has
 * a relationship with the user - the same carpool group, or an existing request
 * between them - so that a caller which forgets to choose gets the safe result.
 *
 * @param search an active CarpoolSearch record with user and location relations
 * @returns non-sensitive information about a user, home coarsened, no email
 */
export const convertCarpoolSearchToPublic = (
  search: CarpoolSearchWithRelations,
): PublicUser => {
  const publicUser = buildPublicUser(search);

  return {
    ...publicUser,
    startCoordLng: coarsenHomeCoord(publicUser.startCoordLng),
    startCoordLat: coarsenHomeCoord(publicUser.startCoordLat),
  };
};

export const roundCoord = (coord: number) => {
  return Math.round((coord + Number.EPSILON) * 100000) / 100000;
};
