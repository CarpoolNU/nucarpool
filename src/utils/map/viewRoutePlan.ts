/**
 * What pressing **View Route** on a card should do to the map.
 *
 * This exists because the decision it makes was previously spelled out inline
 * in `onViewRouteClick`, in a shape that could not be true:
 *
 * ```ts
 * const isInRequestContext = selectedUserId && selectedUserId === clickedUser.id;
 * ...
 * if (!isInRequestContext) {
 *   if (!isOtherUserInGeoList && selectedUserId === clickedUser.id) {
 *     // add a destination pin for the off-map user
 *   } else if (!isOtherUserInGeoList && selectedUserId !== clickedUser.id) {
 *     setOtherUser(null);
 *     return;                     // <- returned before viewRoute() ran
 *   }
 * }
 * ```
 *
 * The first inner branch asks for `selectedUserId === clickedUser.id`, which is
 * precisely what makes `isInRequestContext` truthy - so inside
 * `if (!isInRequestContext)` it was unreachable, and ids are cuids so no
 * falsy-equality case rescues it. Every click on a user the map was not already
 * plotting fell to the `else if` and returned before the route was drawn.
 * Nothing was logged and no toast was raised, so the button simply did nothing.
 *
 * That was true from the moment it was written (`b97fc6b`, 2025-11-13) and it
 * is reachable on **default filter settings**: `initialFilters.messaged` is
 * `false`, and `mapbox.geoJsonUserList` excludes every user you have a request
 * with when `messaged` is false. So the map deliberately omits exactly the
 * people whose cards you are most likely to press. `MAP_RESULT_LIMIT = 150` is
 * a second route into the same state, as are the distance, day and date
 * filters, an `INACTIVE` counterpart, and an incompatible role.
 *
 * **The decision recorded here: a route is drawn for anyone with usable
 * coordinates, whether or not the map is currently plotting them.** The dead
 * branch's intent - give an off-map user a destination pin so the route has
 * both ends visible - is kept, because that is the behaviour the original
 * author was reaching for. Absence from `geoJsonUsers` is a statement about the
 * *discovery query's* filters, not about whether two people's routes can be
 * compared, so it was never a good reason to refuse.
 *
 * **What this deliberately does not decide is whether to draw the route.**
 * There is no `drawsRoute` field, because the answer is unconditionally yes and
 * a plan field that never varies is a field nobody reads. The invariant is
 * pinned where the drawing happens instead: `viewRouteClick.test.ts` asserts
 * that `viewRoute` is reached for every combination of these inputs. Gating the
 * call on an always-true flag would only have replaced one unreachable branch
 * with another.
 *
 * Extracted as a pure function for the reason `connectAction.ts` and
 * `viewerAccess.ts` give, and for one more specific to this defect: a
 * contradictory condition is invisible in review and invisible to a suite that
 * cannot reach the code. Stating the decision where a test can enumerate every
 * input is what makes "this branch can never run" a failing assertion rather
 * than a comment nobody wrote.
 */

export type ViewRoutePlan = {
  /**
   * Whether the click came from the Map tab inside `MessagePanel`, which passes
   * the same id as both the selected and the clicked user.
   *
   * This is the one path that worked before the fix, which is why the defect
   * survived: the route someone would deliberately test is the route that was
   * never broken.
   */
  isInRequestContext: boolean;

  /**
   * Whether the page should point its `otherUser` state at the clicked user.
   *
   * Skipped in request context, exactly as before. `otherUser` is what holds
   * the "initial route rendering" effect shut - that effect is guarded on
   * `!otherUser` and redraws the viewer's own route - and in request context
   * `MessagePanel` owns the selection instead.
   */
  selectsClickedUser: boolean;

  /**
   * Whether to add the clicked user's destination pin
   * (`updateCompanyLocation`, `isCurrent: false`).
   *
   * Outside request context this is the fix: it is now `true` for a user the
   * map is not plotting, which is what the unreachable branch was written to
   * do. It stays `false` for a user already in `geoJsonUsers`, because the
   * cluster layer is already drawing them at that same company coordinate and a
   * pin would double it.
   *
   * In request context it is unconditional, which is *deliberately* asymmetric:
   * that is what the working path did before, and `MessagePanel`'s Map tab is
   * the regression this change has to protect. The asymmetry is only observable
   * with the "messaged" filter turned on, where a request counterpart can be on
   * the map and gets a pin over their cluster point - pre-existing behaviour,
   * left alone on purpose.
   */
  addsDestinationMarker: boolean;

  /**
   * **Removed in SCRUM-391**, along with the `markedDestinationUserId` input it
   * was computed from: `removesDestinationMarkerFor`, naming the one previously
   * added pin to take off first.
   *
   * That field existed because pin removal was keyed by identity - a pin is a
   * named layer, so you could only remove one you had remembered adding - and
   * this doc argued against the alternative: "Only ever names the one
   * remembered pin, never a sweep of every `other-user-*` layer.
   * `onViewGroupRoute` puts a pin on every group member, and a sweep here would
   * erase them."
   *
   * That was right about the danger and wrong about the remedy. The pins it was
   * protecting were the ones nothing *ever* removed, which is SCRUM-391 - they
   * outlived the route they belonged to, the tab they were drawn on, and the
   * session. `clearOtherUserMarkers` now sweeps them at the *start* of both
   * handlers, before either draws its own, so the group preview re-adds every
   * member immediately after and no pin it owns is ever the one erased.
   *
   * With the sweep there is no remembered pin left to name, so the field, the
   * page`s `destinationMarker` ref and `removeDestinationMarker` all went with
   * it. Recorded here rather than deleted silently because the argument above
   * is the one a future reader is most likely to re-derive.
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
