/**
 * What counts as a usable pair of coordinates, defined once so the client, the
 * Mapbox boundary and the procedure that writes to the database all agree
 * (SCRUM-302).
 *
 * Two separate things are checked here, and they fail in different ways.
 *
 * **Range.** `location.coord_lat` / `coord_lng` are plain `Float` columns, so
 * MySQL accepts any number at all. A value outside the WGS 84 range is not a
 * place: `locationWithin` builds its bounding box by adding a degree delta to
 * the centre, and `milesBetween` feeds the value into `Math.cos`, so an
 * out-of-range row is not merely wrong, it is arbitrary. `getDirections` in
 * `server/router/mapbox.ts` already refused these before forwarding them
 * upstream (SCRUM-244); the boundary that *stores* them did not.
 *
 * **Resolution.** `useAddressSelection` starts at `center: [0, 0]` and the
 * combobox resets to it when the input is cleared, so `(0, 0)` is the sentinel
 * this app uses for "no address has been picked yet" — not a coordinate a
 * student can plausibly have. It is inside the valid range, which is exactly
 * why it needs its own check: a profile saved before the address resolved put a
 * pin in the Gulf of Guinea, ~4000 miles from every real candidate, so the row
 * was silently excluded from every distance-filtered search.
 *
 * The resolution check is deliberately the *exact* pair, not "either component
 * is zero". Longitude 0 is Greenwich and latitude 0 is the equator; a row at
 * one of them and not the other is a real place somebody could conceivably
 * live, and rejecting it would be a false positive. Only the sentinel itself
 * means "unresolved".
 */

import { z } from "zod";
import { Role } from "@prisma/client";

/** WGS 84 longitude, in degrees east. */
export const MIN_LONGITUDE = -180;
export const MAX_LONGITUDE = 180;

/** WGS 84 latitude, in degrees north. */
export const MIN_LATITUDE = -90;
export const MAX_LATITUDE = 90;

export const longitudeSchema = z.number().min(MIN_LONGITUDE).max(MAX_LONGITUDE);

export const latitudeSchema = z.number().min(MIN_LATITUDE).max(MAX_LATITUDE);

/**
 * True for the `[0, 0]` sentinel `useAddressSelection` defaults to, and for
 * nothing else. See the note on exactness above.
 */
export const isUnresolvedCoordinate = (lng: number, lat: number): boolean =>
  lng === 0 && lat === 0;

/** The two form fields an unresolved coordinate is reported against. */
export type AddressField = "startAddress" | "companyAddress";

export const UNRESOLVED_ADDRESS_MESSAGE =
  "Pick an address from the suggestions so we can place it on the map";

/**
 * Which address fields have not been resolved to a real point.
 *
 * A VIEWER is exempt: they are browsing rather than matching, both address
 * fields are optional for them in `onboardSchema`, and `(0, 0)` is what
 * `user.me` already reports for a row with no `Location`. Refusing it would
 * make a VIEWER unable to save their profile at all.
 *
 * The form fields hold address *text*, which is what `onboardSchema` checks.
 * This checks the coordinates that text was supposed to resolve to, and the two
 * can disagree: the combobox only writes back to the form when a suggestion is
 * chosen, so text left over from a previous save can sit next to `[0, 0]`.
 */
export const unresolvedAddressFields = ({
  role,
  home,
  company,
}: {
  role: Role;
  home: readonly [number, number];
  company: readonly [number, number];
}): AddressField[] => {
  if (role === Role.VIEWER) {
    return [];
  }

  const fields: AddressField[] = [];
  if (isUnresolvedCoordinate(home[0], home[1])) {
    fields.push("startAddress");
  }
  if (isUnresolvedCoordinate(company[0], company[1])) {
    fields.push("companyAddress");
  }
  return fields;
};
