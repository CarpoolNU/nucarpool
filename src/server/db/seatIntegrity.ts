/**
 * Seat-count integrity.
 *
 * `CarpoolSearch.seatsAvail` is supposed to stay inside
 * `[0, MAX_SEATS_AVAILABLE]`. Nothing enforced it: the column is a plain `Int`,
 * `relationMode = "prisma"` and PlanetScale's online-DDL path put `UNSIGNED`
 * and CHECK constraints out of easy reach, and `clampSeats` is applied only
 * when seats are released. The accounting bugs SCRUM-229 fixed had already
 * pushed at least one ACTIVE driver to `-1` by then, and nothing has ever
 * looked.
 *
 * Kept as a pure function for the same reason as `findOrphanLocationIds`: the
 * selection is what is worth testing, and it can be tested without a database.
 * The reads live in `scripts/check-seat-counts.ts` and the writes in
 * `scripts/repair-seat-residue.ts`.
 */

import { clampSeats, isSeatCountInRange } from "../../utils/carpoolSeats";

/** The columns either script needs to report or repair one row. */
export type SeatCountRow = {
  id: string;
  userId: string;
  role: string;
  status: string;
  seatsAvail: number;
  carpoolId: string | null;
};

export type OutOfRangeSeatRow = {
  row: SeatCountRow;
  /** What a repair would write: the current value, clamped into range. */
  repairTo: number;
};

/**
 * The rows whose seat count is outside `[0, MAX_SEATS_AVAILABLE]`, each paired
 * with the value a repair would write.
 *
 * `repairTo` is `clampSeats` and nothing cleverer. For a negative row that
 * means `0` — "no space right now" — rather than a guess at the capacity the
 * driver originally entered. The capacity is not stored anywhere to recover
 * (see the header of `carpoolSeats.ts`), so any other number would be
 * invented, and inventing upwards would over-subscribe a real car. The driver
 * can raise it themselves by re-saving their profile.
 *
 * Rows already in range are omitted entirely, which is what makes a repair
 * idempotent: a second run finds nothing to do. `repairTo` is therefore always
 * in range, including for the fractional value the column cannot hold —
 * truncated before clamping, because `clampSeats(2.5)` is still `2.5`.
 */
export const findOutOfRangeSeatRows = (
  rows: readonly SeatCountRow[],
): OutOfRangeSeatRow[] =>
  rows
    .filter((row) => !isSeatCountInRange(row.seatsAvail))
    .map((row) => ({ row, repairTo: clampSeats(Math.trunc(row.seatsAvail)) }));
