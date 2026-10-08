/**
 * What pressing **View Route** on a card should do to the map.
 *
 * **The decision: a route is drawn for anyone with usable coordinates, whether
 * or not the map is currently plotting them.** An off-map user also gets a
 * destination pin so the route has both ends visible.
 *
 * Absence from `geoJsonUsers` is a statement about the *discovery query's*
 * filters, not about whether two people's routes can be compared — so it is
 * never a reason to refuse. That matters because the omission is routine:
 * `initialFilters.messaged` is `false` and `geoJsonUserList` then excludes
 * every user you have a request with, so the map omits exactly the people whose
 * cards you are most likely to press. `MAP_RESULT_LIMIT`, the distance, day and
 * date filters, an `INACTIVE` counterpart and an incompatible role all reach
 * the same state.
 *
 * **This deliberately does not decide whether to draw the route.** There is no
 * `drawsRoute` field, because the answer is unconditionally yes and a plan
 * field that never varies is a field nobody reads. The invariant is pinned
 * where the drawing happens: `viewRouteClick.test.ts` asserts `viewRoute` is
 * reached for every combination of these inputs.
 *
 * Extracted as a pure function so a contradictory condition becomes a failing
 * assertion rather than a comment: inline in `onViewRouteClick`, a
 * contradictory condition is invisible in review and invisible to a suite
 * that cannot reach the code. Stating the decision here, where a test can
 * enumerate every input, is what catches "this branch can never run."
 */

export type ViewRoutePlan = {
  /**
   * Whether the click came from the Map tab inside `MessagePanel`, which passes
   * the same id as both the selected and the clicked user.
   *
   * This is the path most straightforward to test by hand, which is exactly
   * why a defect confined to the other paths is easy to miss: manually
   * confirming the route works here says nothing about whether it draws for
   * anyone else.
   */
  isInRequestContext: boolean;

  /**
   * Whether the page should point its `otherUser` state at the clicked user.
   *
   * Skipped in request context. `otherUser` is what holds
   * the "initial route rendering" effect shut - that effect is guarded on
   * `!otherUser` and redraws the viewer's own route - and in request context
   * `MessagePanel` owns the selection instead.
   */
  selectsClickedUser: boolean;

  /**
   * Whether to add the clicked user's destination pin
   * (`updateCompanyLocation`, `isCurrent: false`).
   *
   * Outside request context this is `true` for a user the map is not
   * plotting and `false` for one already in `geoJsonUsers`, because the
   * cluster layer is already drawing them at that same company coordinate and
   * a pin would double it.
   *
   * In request context it is unconditional, which is *deliberately* asymmetric
   * with the rule above: `MessagePanel`'s Map tab depends on that asymmetry
   * holding, so it is pinned here rather than left to fall out of the general
   * rule. The asymmetry is only observable with the "messaged" filter turned
   * on, where a request counterpart can be on the map and gets a pin over
   * their cluster point - pre-existing behaviour, left alone on purpose.
   */
  addsDestinationMarker: boolean;

  /**
   * No field names a pin to remove: there is nothing to remember. A sweep
   * naming one remembered pin at a time cannot work once `onViewGroupRoute`
   * puts a pin on every group member, so removal goes by asking the map what
   * exists instead of tracking identity. `clearOtherUserMarkers` runs that
   * sweep at the *start* of both handlers, before either draws its own pin, so
   * the group preview re-adds every member immediately after and no pin it
   * owns is ever the one erased.
   */
};

export const planViewRoute = ({
  clickedUserId,
  selectedUserId,
  isClickedUserOnMap,
}: {
  clickedUserId: string;
  /**
   * The conversation the page currently has open, or `null`.
   *
   * Can also be the empty string: `handleUserSelect("")` is how the sidebar
   * clears a selection. Compared for truthiness rather than against `null` so
   * that `""` counts as "nothing selected", which is what the original
   * `selectedUserId && ...` did.
   */
  selectedUserId: string | null;
  /** Whether `geoJsonUsers.features` currently carries the clicked user. */
  isClickedUserOnMap: boolean;
}): ViewRoutePlan => {
  const isInRequestContext =
    Boolean(selectedUserId) && selectedUserId === clickedUserId;

  return {
    isInRequestContext,
    selectsClickedUser: !isInRequestContext,
    addsDestinationMarker: isInRequestContext || !isClickedUserOnMap,
  };
};
