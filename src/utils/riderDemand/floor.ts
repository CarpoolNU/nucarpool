/**
 * The suppression floor for the rider-demand count, and the reasoning for it.
 *
 * The count this governs answers "how many riders would you be able to carry
 * if you switched to Driver". It is deliberately a bare number: showing *who*
 * wants a ride would expose people who never opted into being found by that
 * reader, and the small-population argument that makes ratings de-anonymising
 * in [`docs/design/post-match-feedback.md`](../../../docs/design/post-match-feedback.md)
 * applies here unchanged — "aggregation cannot fix this because there is
 * nothing to aggregate over".
 *
 * ## Why three
 *
 * A count is not anonymous on its own. It becomes identifying when the reader
 * can line it up against something else they can see, and one role can:
 *
 *   - A **RIDER** sees only drivers on the map — `compatibleRoles(RIDER)` is
 *     `[DRIVER]` — so rider pins are not available to them and there is
 *     nothing to cross-reference a rider count against.
 *   - A **VIEWER** sees *both* roles: `compatibleRoles(VIEWER)` returns
 *     `[DRIVER, RIDER]`, and `mapbox.geoJsonUserList` serves that role. So a
 *     VIEWER reading "1 rider wants a route like yours" beside a single rider
 *     pin in their corridor has been told who that person is, and "2" beside
 *     two pins is a list of two people written as a number.
 *
 * Three is the smallest floor that closes that reading. It is set here rather
 * than per surface because the hazard is the number itself, not where it is
 * painted — a floor that depended on the surface would be one refactor away
 * from a VIEWER seeing a count of one.
 *
 * **Not five**, which is the conventional small-cell suppression threshold in
 * disclosure control. Five is the right answer when the aim is to publish a
 * table and the cost of suppressing a cell is a gap in it. Here the cost is
 * the entire feature: production holds roughly 287 live ungrouped riders
 * spread across every corridor the platform serves, so a per-route count of
 * five or more is uncommon enough that the notice would rarely appear at all
 * — and the corridors where it would fire are the ones least in need of
 * another driver. A floor that never fires is not a cautious version of this
 * feature, it is the absence of it.
 *
 * **Raising it is cheap and lowering it is not.** If the measurement in the
 * ticket shows the notice firing too readily, or if a VIEWER is ever given a
 * finer view of rider geography than a map pin, raise this number and the
 * suppression follows everywhere. Going the other way means re-arguing the
 * cross-reference above, so treat 3 as a floor on the floor.
 *
 * ## Where it is enforced
 *
 * **On the server**, in `riderDemandCount`. A floor applied in the component
 * would still have put the exact number on the wire, where the network tab
 * reads it — which is the whole disclosure the floor exists to prevent. The
 * client never receives a sub-floor count; it receives `null`.
 *
 * This module holds no imports so that the server query, the shared types and
 * the two components can all read it without dragging anything across that
 * boundary — the same reason `filters/filterSentinels.ts` is written that way.
 */

/**
 * The smallest count that may be shown. Below this the reader is told nothing
 * at all, not "fewer than three" — a floor that announces itself still
 * narrows the range, and the range is the disclosure.
 */
export const RIDER_DEMAND_FLOOR = 3;

/**
 * The count as it may be disclosed, or `null` when it may not be.
 *
 * Collapses zero and every sub-floor count to the same answer on purpose: the
 * caller cannot distinguish "nobody" from "two" from this return value, and
 * neither can anyone reading what the caller renders.
 *
 * A negative input cannot arise from a `length`, and is folded into `null`
 * rather than trusted, so this is total over its argument type.
 */
export const riderDemandToDisplay = (count: number): number | null =>
  count >= RIDER_DEMAND_FLOOR ? count : null;
