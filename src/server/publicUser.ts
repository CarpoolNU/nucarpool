import { Location, CarpoolSearch, RequestStatus } from "@prisma/client";
import { PublicUser } from "../utils/types";

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
 * Only for a viewer who already has a **mutual** relationship with this user -
 * the same carpool group, or a request between them that was *accepted*.
 * Everything else must use `convertCarpoolSearchToPublic`.
 *
 * **Mutual is the load-bearing word, and it used to be missing.** The rule was
 * written as "an existing request between them", which sounds like a
 * relationship and is not one: `requests.create` lets any signed-in user create
 * a request to any other user unilaterally, with no consent and no
 * acknowledgement from the person it names. So the viewer could manufacture
 * their own authorisation - send a request, then read the exact home coordinate
 * and email address of whoever they had just named - and doing that once per id
 * returned by `mapbox.geoJsonUserList` walked the whole user base. That stepped
 * around both the coarsening and the `email` removal, which is what
 * `convertRequestCounterpart` below now prevents by asking *which* request
 * status is evidence of anything.
 *
 * Group membership was always mutual and is unchanged: `groups.me` reaches this
 * through people who have already agreed to carpool together.
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
 * a mutual relationship with the user - the same carpool group, or an accepted
 * request between them - so that a caller which forgets to choose gets the safe
 * result. For a request specifically, reach for `convertRequestCounterpart`
 * below rather than choosing by hand: the status test is the whole of the rule,
 * and a caller writing it out again is a caller who can get it wrong.
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

/**
 * The counterpart of a request, disclosing what that request's status has
 * actually established.
 *
 * A plain function rather than a conditional inside `requests.me`, for the
 * reason `canSubscribe` gives: this *is* the access rule, so it should be
 * testable on its own rather than only through a procedure that needs a Prisma
 * double to reach.
 *
 * **`ACCEPTED` is the line, and only `ACCEPTED`.** A `PENDING` request records
 * that somebody asked, which one person can do alone and about anybody;
 * accepting is the first point at which the person being disclosed has agreed
 * to anything. `markRequestAccepted` writes that status inside the same
 * transaction as the group membership, so it is exactly as trustworthy as the
 * membership itself.
 *
 * Deliberately **not** also exempting a request the viewer merely *received*.
 * That is better evidence than one they sent - the other person chose to make
 * contact - but it is still not agreement by the person whose home coordinate
 * is at stake, and nothing in the product needs it: deciding whether to accept
 * uses the neighbourhood point and the in-app thread, which is what every
 * recommendation card already offers before a request exists at all.
 *
 * The counterpart stays *visible* either way. This narrows what each request
 * discloses and never which requests are returned - hiding them is what
 * SCRUM-296 and SCRUM-316 were filed to undo.
 *
 * @param search the counterpart's CarpoolSearch, with user and location relations
 * @param status the status of the request between the viewer and that user
 */
export const convertRequestCounterpart = (
  search: CarpoolSearchWithContact,
  status: RequestStatus,
): PublicUser =>
  status === RequestStatus.ACCEPTED
    ? convertCarpoolSearchToPublicWithExactHome(search)
    : // `search` carries an `email` the coarsened converter does not read:
      // `buildPublicUser` enumerates its fields, so the address is dropped
      // rather than passed through. The column is still selected because one
      // query serves requests of both statuses and cannot know per row which
      // converter will be used.
      convertCarpoolSearchToPublic(search);

export const roundCoord = (coord: number) => {
  return Math.round((coord + Number.EPSILON) * 100000) / 100000;
};
