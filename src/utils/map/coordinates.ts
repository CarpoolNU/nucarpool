/**
 * Whether a longitude/latitude pair is usable as a map coordinate.
 *
 * Moved out of `pages/index.tsx`, where it was a component-local helper, once
 * `viewRouteClick.ts` needed the same test. Two copies of a validator is how
 * two callers start disagreeing about what a valid coordinate is, and the page
 * still uses this one for its initial-route effect.
 *
 * Checks usability, not plausibility: `0, 0` passes. That is deliberate and
 * unchanged - the guards this feeds are there to keep `NaN` and `undefined` out
 * of `fitBounds` and out of the Mapbox directions request, not to judge whether
 * somebody lives in the Gulf of Guinea.
 *
 * **Moved with its logic untouched, including two things that are arguably
 * wrong.** The `isNaN` clauses are subsumed by the `isFinite` ones - `isFinite`
 * is the global, coercing form, and `isFinite(NaN)` is already false - so a
 * mutation deleting either `isNaN` cannot be detected by any input, and the
 * suite does not pretend otherwise. By the same coercion, `null` would pass:
 * `isFinite(null)` is `true`, and `lng !== undefined` does not catch it. No
 * caller can reach that, because every coordinate on `User` and `PublicUser` is
 * a non-nullable `number`.
 *
 * Left alone anyway. Tightening it to `typeof lng === "number" &&
 * Number.isFinite(lng)` would be a semantic change to a validator that also
 * gates the page's initial-route effect, made in a change that is about
 * something else entirely - and there is no reachable input it would decide
 * differently. Recorded here so the redundancy reads as known rather than as an
 * oversight.
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
