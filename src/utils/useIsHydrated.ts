import { useSyncExternalStore } from "react";

/**
 * Never fires. The value this hook reports changes exactly once - from the
 * server snapshot to the client one - and React performs that transition
 * itself when it notices the two disagree. There is no external source to
 * subscribe to, so `subscribe` exists only to satisfy the signature.
 *
 * Declared at module scope for the same reason `useIsMobile`'s is: React
 * resubscribes whenever this function's identity changes.
 */
const subscribe = () => () => undefined;

/** Any render reached from the client, after hydration has been reconciled. */
const getSnapshot = () => true;

/** The server render, and the hydration pass that has to match it. */
const getServerSnapshot = () => false;

/**
 * `false` while a render could still be the hydration pass, `true` afterwards.
 *
 * `useIsMobile` reports the real viewport on its first render, but React uses
 * `getServerSnapshot` during *hydration* too — so a viewport-branching
 * component already in the server HTML renders its desktop branch once on a
 * phone. The server cannot know the device, so that pass is unavoidable; what
 * is avoidable is paying for it. This marks it, so work can be held back until
 * the render is known not to be it. Two callers use it:
 *
 *  - `useProfileImage` gates its query, so a `DropDownMenu` that hydrates on a
 *    phone and is immediately replaced fires no presigned-URL request. React
 *    Query subscribes in a passive effect, which runs *before* React's
 *    corrective re-render, so the fetch really did go out.
 *  - `admin.tsx` gates `Header`, so the desktop branch is not in that page's
 *    server HTML at all.
 *
 * **Why `useSyncExternalStore` and not `useState(false)` plus an effect.** The
 * effect form reports `false` on the first render of *every* consumer,
 * including the ones that mount fresh on the client and have no problem — on
 * the explore page that would defer fifty avatar requests to fix a bug none of
 * them has. This form reports `true` immediately on a fresh mount and `false`
 * only where `getServerSnapshot` is used, so the cost falls exactly on the
 * subtrees that hydrate.
 *
 * **This cannot produce a hydration mismatch**, which is the point of reading
 * it through a store: the server and the hydration pass both take
 * `getServerSnapshot` and agree by construction. A `typeof window` check would
 * not — it takes its client branch during SSR under jsdom and its server branch
 * in Node, which is why that shape reads as equivalent in tests and diverges in
 * production.
 */
const useIsHydrated = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export default useIsHydrated;
