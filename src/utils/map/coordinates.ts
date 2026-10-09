/**
 * Whether a longitude/latitude pair is usable as a map coordinate.
 *
 * Shared between `pages/index.tsx`, which uses it for its initial-route
 * effect, and `viewRouteClick.ts`. Two copies of a validator is how two
 * callers start disagreeing about what a valid coordinate is.
 *
 * Checks usability, not plausibility: `0, 0` passes. That is deliberate - the
 * guards this feeds are there to keep `NaN` and `undefined` out of `fitBounds`
 * and out of the Mapbox directions request, not to judge whether somebody
 * lives in the Gulf of Guinea.
 *
 * **Known redundant in two ways, both left alone.** The `isNaN` clauses are
 * subsumed by the `isFinite` ones - `isFinite` is the global, coercing form,
 * and `isFinite(NaN)` is already false - so a mutation deleting either `isNaN`
 * cannot be detected by any input, and the suite does not pretend otherwise.
 * By the same coercion, `null` would pass: `isFinite(null)` is `true`, and
 * `lng !== undefined` does not catch it. No caller can reach that, because
 * every coordinate on `User` and `PublicUser` is a non-nullable `number`.
 *
 * Tightening this to `typeof lng === "number" && Number.isFinite(lng)` would
 * be a semantic change to a validator that also gates the page's
 * initial-route effect, for no reachable input it would decide differently.
 * Recorded here so the redundancy reads as known rather than as an oversight.
 */
export const isValidCoordinates = (lng?: number, lat?: number): boolean => {
  return (
    lng !== undefined &&
    lat !== undefined &&
    true &&
    !isNaN(lat) &&
    isFinite(lng) &&
    isFinite(lat)
  );
};
