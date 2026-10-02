/**
 * Where the map belongs for a given user — the point it opens on, and the point
 * the Recentre button flies back to.
 *
 * **These were two expressions of one fact and they disagreed.** `index.tsx`
 * derived the initial centre with a VIEWER case (`role === "VIEWER" ? NEU :
 * workplace`) and the recentre handler took the workplace unconditionally. A
 * VIEWER has no `Location` row, `user.me` reports `?? 0` for both components,
 * and so pressing a control labelled "Recentre the map on your workplace" flew
 * a third of production to `(0, 0)` in the Gulf of Guinea — the same sentinel
 * `isUnresolvedCoordinate` exists to recognise. Deriving it once is the fix;
 * the duplication was the defect.
 *
 * **The check is on the coordinate, not only on the role.** A VIEWER is the
 * common case — `unresolvedAddressFields` exempts them precisely because
 * `(0, 0)` is what a row with no `Location` reports — but it is not the only
 * one. A profile saved before its address resolved carries the same sentinel at
 * any role, and the old role-only test sent those users to the Gulf too. The
 * role case is kept as well rather than replaced: a user who was a DRIVER and
 * switched to VIEWER still has their old company coordinates on the row, and
 * opening a browsing user's map on a workplace they no longer commute to is the
 * behaviour `SCRUM-508` settled. Role first, then resolution.
 */

import { Role } from "@prisma/client";
import { isUnresolvedCoordinate } from "../coordinates";

/**
 * Northeastern's Boston campus. The fallback for anyone with no workplace of
 * their own to centre on, which is every VIEWER and any row whose address never
 * resolved.
 */
export const NEU_LAT = 42.33907;
export const NEU_LNG = -71.088748;

/** `[lng, lat]`, the order Mapbox takes. */
export type MapCentre = [number, number];

/**
 * The campus point, for comparison and for tests.
 *
 * `mapHomeCentre` deliberately does **not** hand this instance out. It is a
 * module-level mutable array, and the value it returns is passed straight to
 * Mapbox's constructor and then held in a ref by `useMapInstance` - so sharing
 * one instance across every VIEWER's map would be an aliasing hazard for no
 * gain. Each call builds its own pair, which is what the ternary this replaced
 * did too.
 */
export const NEU_CENTRE: MapCentre = [NEU_LNG, NEU_LAT];

/**
 * The subject of the Recentre button's label, so the control can say where it
 * is actually going. Promising "your workplace" to a user who has none was the
 * half of this defect that a correct `flyTo` would not have fixed.
 */
export type MapCentreSubject = "workplace" | "campus";

type MapHomeUser = {
  role: Role;
  companyCoordLng: number;
  companyCoordLat: number;
};

/** True when this user has a real workplace to centre on. */
export const hasWorkplaceCentre = (user: MapHomeUser): boolean =>
  user.role !== Role.VIEWER &&
  !isUnresolvedCoordinate(user.companyCoordLng, user.companyCoordLat);

export const mapHomeCentre = (user: MapHomeUser): MapCentre =>
  hasWorkplaceCentre(user)
    ? [user.companyCoordLng, user.companyCoordLat]
    : [NEU_LNG, NEU_LAT];

export const mapHomeSubject = (user: MapHomeUser): MapCentreSubject =>
  hasWorkplaceCentre(user) ? "workplace" : "campus";
