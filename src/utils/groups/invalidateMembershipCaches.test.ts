/**
 * The one definition of what a carpool membership change makes stale.
 *
 * Three call sites share it - `useGroupMembership`'s two `onSuccess` handlers
 * and `requestHandlers.ts`'s `invalidateAcceptedRequestCaches` - and each has
 * its own suite asserting that it invalidates this set. Those prove the sites
 * agree with each other; this one proves what they agree *on*, which is the
 * part a reader of any single call site cannot see.
 *
 * The set is spelled out rather than imported from the module under test. An
 * expectation read off the code it is checking asserts only that the code
 * equals itself, and would accept any future edit to the list.
 */

import { recordInvalidations } from "../../testing/invalidationRecorder";
import { invalidateMembershipCaches } from "./invalidateMembershipCaches";

const MEMBERSHIP_CACHES = [
  "mapbox.geoJsonUserList.invalidate",
  "user.groups.me.invalidate",
  "user.me.invalidate",
  "user.recommendations.me.invalidate",
  "user.requests.me.invalidate",
];

describe("invalidateMembershipCaches", () => {
  it("invalidates exactly the five caches a membership change changes", () => {
    const recorder = recordInvalidations();

    invalidateMembershipCaches(recorder.utils);

    // Sorted `calls`, not `paths()`: this is the set *and* the count, so a
    // double invalidation fails here too. The two discovery queries are the
    // expensive ones - `recommendations.me` runs the full scoring pass and
    // `geoJsonUserList` is metered against the Mapbox quota - so calling this
    // helper must not cost two of each.
    expect([...recorder.calls].sort()).toEqual(MEMBERSHIP_CACHES);
  });

  /*
   * The two caches SCRUM-629 was about, named on their own.
   *
   * A grouped RIDER matches nobody, so the server answers both of these with
   * an empty set - correctly, while they are grouped. Nothing re-asks on their
   * behalf once they leave: `utils/trpc.ts` turns `refetchOnMount` and
   * `refetchOnWindowFocus` off globally, `pages/index.tsx` owns both queries
   * and renders `GroupPage` inside itself, and the query key does not depend
   * on membership. Dropping either of these from the list above puts the rider
   * back on an empty Explore sidebar and an empty map for the rest of the
   * session, which reads exactly like "no drivers match you".
   */
  it("covers the two discovery queries nothing else would refetch", () => {
    const recorder = recordInvalidations();

    invalidateMembershipCaches(recorder.utils);

    expect(recorder.paths()).toContain("user.recommendations.me.invalidate");
    expect(recorder.paths()).toContain("mapbox.geoJsonUserList.invalidate");
  });

  /*
   * It returns nothing to await, deliberately. The three call sites are
   * `onSuccess` handlers: a promise returned from one keeps React Query's
   * mutation pending until every refetch settles, which would hold the
   * `isMutating` flag - and so the disabled Leave and Remove buttons - for as
   * long as the scoring pass takes, and delay the toast and the modal dismiss
   * behind it. Asserted so a later change to `Promise.all` has to be a
   * deliberate one.
   */
  it("does not hand the caller a promise to wait on", () => {
    const recorder = recordInvalidations();

    expect(invalidateMembershipCaches(recorder.utils)).toBeUndefined();
  });
});
