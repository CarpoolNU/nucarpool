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

/**
 * "This driver has a seat a rider can take."
 *
 * One definition, because the app used to hold two. `reserveSeat` has always
 * decremented under `seatsAvail: { gt: 0 }`, while the read path — the
 * candidate query, `calculateScore`, and the two buttons — tested `=== 0`.
 * They agree on every value the app can now produce and disagree on exactly
 * one: a negative count, which the read path reads as "has space" and the
 * write path as "does not".
 *
 * SCRUM-229 stopped new negatives (the compare-and-swap above), but rows the
 * old accounting had already corrupted stayed, and one belonged to an ACTIVE
 * driver. That driver was recommended to riders as having room and then
 * refused every acceptance with NO_SEATS_MESSAGE — a message naming
 * themselves, which neither party could act on.
 *
 * Non-positive is unavailable, everywhere. The write path was already right;
 * this is what the read path now uses so it cannot drift again.
 */
export const hasSeatAvailable = (seats: number) => seats > 0;

/**
 * `hasSeatAvailable` as a Prisma filter, for the predicate the database has to
 * evaluate rather than JavaScript.
 *
 * Shared rather than written out at each site so the two cannot diverge
 * silently: `carpoolSeats.test.ts` evaluates this filter against the same
 * values it feeds `hasSeatAvailable` and asserts the verdicts match, which
 * fails if either one is changed alone. `candidateSearch.ts` additionally
 * depends on SQL keeping a superset of what the scorer keeps, and identity is
 * the simplest way to satisfy that.
 */
export const SEAT_AVAILABLE_FILTER = { gt: 0 } as const;

/**
 * True when a stored seat count is one the app could have written.
 *
 * `clampSeats` bounds computed values, but only on the release path, and
 * nothing has ever checked what is already in the column. This is the
 * predicate `scripts/check-seat-counts.ts` reports on and
 * `scripts/repair-seat-residue.ts` repairs — the invariant this file's header
 * has always claimed, finally stated as code.
 *
 * Non-integers count as out of range. `seats_avail` is an `Int` column so one
 * cannot be stored, but a fractional value would fail every comparison here in
 * a way worth reporting rather than silently accepting.
 */
export const isSeatCountInRange = (seats: number) =>
  Number.isInteger(seats) && seats >= 0 && seats <= MAX_SEATS_AVAILABLE;
