/**
 * Driver seat availability.
 *
 * `CarpoolSearch.seatsAvail` is the number of seats a driver still has free. It
 * starts as the capacity they enter during onboarding and is decremented as
 * riders join, so the same column means "capacity" before a group exists and
 * "remaining" afterwards. Capacity is never stored separately, which is why
 * these counts are maintained by hand rather than derived from membership —
 * deriving them would need a schema change and is noted on the ticket.
 *
 * Until then the invariant is simply that the value stays within range, and
 * that the range is stated once rather than as a `6` repeated across the
 * router and two Zod schemas.
 */

export const MAX_SEATS_AVAILABLE = 6;

/** Keeps a computed seat count inside [0, MAX_SEATS_AVAILABLE]. */
export const clampSeats = (seats: number) =>
  Math.min(Math.max(seats, 0), MAX_SEATS_AVAILABLE);

export const NO_SEATS_MESSAGE =
  "Driver does not have space available in their car";
