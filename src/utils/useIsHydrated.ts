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
 * ---
 *
 * **What this is for** (SCRUM-423).
 *
 * `useIsMobile` reports the real viewport on its first render, but React uses
 * `getServerSnapshot` during *hydration* as well as on the server - so a
 * viewport-branching component that is already in the server HTML renders its
 * desktop branch once on a phone before correcting. `useIsMobile`'s docblock
 * covers why that is unavoidable: the server cannot know the device.
 *
 * What *is* avoidable is paying for that discarded pass. This hook marks it,
 * so work can be held back until the render is known not to be it. Two callers
 * use it, for the two halves of the cost:
 *
 *  - `useProfileImage` gates its query on it, so a `DropDownMenu` that
 *    hydrates on a phone and is immediately replaced by the bottom navigation
 *    fires no presigned-URL request. That was one wasted authenticated
 *    request per mobile load of `/admin`, measured under `hydrateRoot` rather
 *    than inferred - React Query subscribes in a passive effect, which runs
 *    *before* React's corrective re-render, so the fetch really did go out.
 *  - `admin.tsx` gates `Header` itself on it, so the desktop header is not in
 *    `/admin`'s server HTML at all and the discarded mount never happens.
 *
 * **Why `useSyncExternalStore` and not `useState(false)` plus an effect.** The
 * effect form is the usual way to write this and it is strictly worse here,
 * because it reports `false` on the first render of *every* consumer -
 * including the ones that mount fresh on the client, which are not the problem
 * and are the overwhelming majority. On the explore page that would defer
 * fifty avatar requests by a render pass to fix a bug none of them has.
 *
 * This form reports `true` on the first render of a fresh client mount, since
 * `getSnapshot` is what React reads there, and `false` only where
 * `getServerSnapshot` is used - the server and the hydration pass. So the cost
 * of the deferral falls exactly on the subtrees that hydrate, which is exactly
 * where the wasted work is.
 *
 * **This does not produce a hydration mismatch**, and that is the point of
 * reading it through a store rather than an initialiser: the server and the
 * hydration pass both take `getServerSnapshot`, so they agree by construction.
 * A `typeof window` check would not - it takes its client branch during SSR
 * under jsdom and its server branch in Node, which is why that shape reads as
 * equivalent in tests and diverges in production.
 */
const useIsHydrated = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export default useIsHydrated;
