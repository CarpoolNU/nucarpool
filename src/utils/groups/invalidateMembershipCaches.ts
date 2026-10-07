import type { trpc } from "../trpc";

/**
 * Everything a change to carpool group membership makes stale, wherever the
 * change came from.
 *
 * One function rather than a list beside each mutation, for the reason
 * `requestHandlers.ts` records in place: its two copies of such a list had
 * already drifted, both missing `groups.me` while `useGroupMembership.ts` -
 * calling the *same* `groups.edit` procedure - invalidated it. This module is
 * that comment coming true a second time, one file over, and the fix is to
 * stop writing the list more than once. `invalidateBlockCaches.ts` is the
 * same shape for blocking.
 *
 * ---
 *
 * **Why `groups.me` is on the list.** It is the member list itself, and the
 * accept path was the copy that had lost it. A driver already in a group who
 * accepts a second rider keeps the same `carpoolId`, so `GroupPage` does not
 * remount and does not refetch - My Group showed the pre-accept membership,
 * without the new rider and without them on "Preview Group Route", for the
 * rest of the session.
 *
 * ---
 *
 * **Why the two discovery queries are on the list** (SCRUM-629).
 *
 * The candidate query deliberately returns *nothing* to a searcher no driver
 * could ever accept - `searcherCanMatchNobody` in `candidateReachability.ts`
 * is true for a grouped RIDER and for a DRIVER with no seats, and
 * `buildCandidateWhere` then narrows to `id IN ()`. So while the caller is
 * grouped, `recommendations.me` and `mapbox.geoJsonUserList` are both
 * correctly empty.
 *
 * The moment membership changes, that answer stops being true, and nothing
 * else re-asks on the caller's behalf. `utils/trpc.ts` sets `refetchOnMount`
 * and `refetchOnWindowFocus` to false globally; `pages/index.tsx` owns both
 * queries and renders `GroupPage` *inside* itself, so leaving a group never
 * unmounts the page that owns them and the `recommendations.me` opt-in to
 * `refetchOnMount` never fires; and the query key is `{ sort, filters }`,
 * which a membership change does not touch. A rider who left was returned to
 * an Explore sidebar with no cards and a map with no pins, for the rest of the
 * session - indistinguishable from "there are genuinely no drivers near you",
 * which with driver supply the platform's real constraint is a believable
 * answer and so not one they would think to reload past.
 *
 * The same invalidation covers the other direction. A rider who *accepts*
 * keeps a full list of drivers they can no longer connect to; `connectAction`
 * refuses correctly because it reads the freshly invalidated `user.me`, but
 * the list should not have been offering them.
 *
 * **This is not in tension with the refetch flags being off.** That policy is
 * about mounts and focus events, which are frequent and carry no information.
 * This is a targeted refetch after a user action that genuinely changed the
 * answer, which is the "opt in per query, next to a reason" case `utils/trpc.ts`
 * describes. Membership changes are rare. Adding `refetchOnWindowFocus` to the
 * two queries instead was rejected: it would paper over this case while
 * reintroducing the scoring pass and the Mapbox quota cost on every tab focus.
 *
 * ---
 *
 * **Why `requests.me` is on the list even for a leave.** Not only because an
 * accept resolves the request row. Every row this query returns carries the
 * *caller's own* side through `convertCarpoolSearchToPublicWithExactHome`, and
 * that projection includes `carpoolId` and `seatAvail` - so leaving a group,
 * or having seats credited back by a removal, changes the payload whether or
 * not any `Request` row was touched.
 *
 * ---
 *
 * **Returns `void`, and the callers do not wait.** Every call site is an
 * `onSuccess` handler. A promise returned from one of those keeps React
 * Query's mutation pending until the refetches settle, which would hold
 * `isMutating` - and so the disabled Leave and Remove buttons - for as long as
 * the scoring pass takes, and delay the toast and the modal dismiss behind it.
 * The caller's screen should react immediately and the discovery queries
 * should catch up behind it, which is what firing and not awaiting gives.
 * `invalidateBlockCaches` does await, because its caller has a confirmation
 * dialog to keep open until the work is done.
 */
export const invalidateMembershipCaches = (
  utils: ReturnType<typeof trpc.useUtils>,
): void => {
  utils.user.me.invalidate();
  utils.user.groups.me.invalidate();
  utils.user.requests.me.invalidate();
  utils.user.recommendations.me.invalidate();
  utils.mapbox.geoJsonUserList.invalidate();
};
