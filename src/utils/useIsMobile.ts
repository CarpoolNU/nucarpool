import { useSyncExternalStore } from "react";
import { isMobileWidth } from "./breakpoints";

/**
 * Subscribe to viewport changes.
 *
 * Declared at module scope rather than inside the hook because React
 * resubscribes whenever this function's identity changes - a new closure per
 * render would tear down and re-add the listener on every render of every
 * consumer.
 */
const subscribe = (onStoreChange: () => void) => {
  window.addEventListener("resize", onStoreChange);

  return () => {
    window.removeEventListener("resize", onStoreChange);
  };
};

/**
 * Read the current viewport.
 *
 * Returning a boolean is what satisfies React's requirement that `getSnapshot`
 * be "cached": it compares snapshots with `Object.is`, so a primitive is
 * equal to itself by value and no memoisation is needed. Returning a fresh
 * object here would loop.
 */
const getSnapshot = () => isMobileWidth(window.innerWidth);

/**
 * What the server must render, and therefore what hydration must start from.
 *
 * `false` - the desktop layout - because `getServerSideProps` runs where there
 * is no `window` and the server has no way to know the device. This is the
 * same default the old `useState(false)` produced; the difference is that it
 * is now stated as a server snapshot rather than being an initial value that
 * happened to double as one.
 */
const getServerSnapshot = () => false;

/**
 * The single source of "is this a mobile viewport". `Header` used to run its
 * own `<= 768` check, which disagreed with this one and produced a desktop
 * layout wearing the mobile navigation between the two values.
 *
 * ---
 *
 * **Why `useSyncExternalStore` and not `useState` plus an effect**.
 *
 * This hook used to be `useState(false)` corrected by a mount effect. An
 * effect runs *after* the render that scheduled it, so the first render pass
 * was unconditionally the desktop branch - on a phone, every consumer rendered
 * its desktop side once and threw it away. For `Header` that was not free: the
 * desktop branch mounts `DropDownMenu`, which calls `useProfileImage`, which
 * fires an authenticated presigned-URL request for an avatar that a mobile
 * visitor never sees.
 *
 * Reading `window.innerWidth` in a `useState` initialiser is the obvious fix
 * and the wrong one - the server cannot produce that value, so it trades the
 * wasted render for a hydration mismatch. `useSyncExternalStore` is the shape
 * that does not have to choose: `getServerSnapshot` keeps the server and
 * hydration agreeing, and `getSnapshot` makes any other first render correct.
 *
 * **What that does and does not buy, measured rather than assumed.** React
 * uses `getServerSnapshot` during *hydration* as well as on the server, so a
 * component present in the server HTML still renders its desktop branch once
 * before correcting. Probed under `hydrateRoot` at a mobile width, the render
 * sequence is `[false, true]`; a fresh client mount is `[true]` from the
 * start. So this fixes any subtree that mounts after hydration and does not
 * fix one that hydrates.
 *
 * In this app that distinction lands well, because `trpc` is configured with
 * `ssr: false`: `/` and `/profile` both return a spinner until `user.me`
 * resolves, so their `Header` mounts fresh on the client and is correct on its
 * first render. `/sign-in` never renders `DropDownMenu` at all. `/admin` was
 * the exception - it rendered `Header` straight from `getServerSideProps`
 * props and so hydrated the desktop branch once.
 *
 * SCRUM-423 closed that, and **not** by teaching the server the device, which
 * is what the residue was originally expected to need. Two gates on
 * `useIsHydrated`, which marks the pass that hydration may discard:
 * `admin.tsx` holds `Header` back so it is no longer in that page's server
 * HTML at all, and `useProfileImage` holds its presigned-URL query back so
 * that any *future* consumer with the same shape costs nothing even before
 * anyone notices it has the shape. The second gate is the one that generalises
 * - this hook's contract is unchanged, and a hydrating subtree still gets one
 * desktop pass, which is what `useIsMobile.test.tsx` still pins.
 *
 * The flash half of the fix is unverifiable here either way: jsdom does not
 * paint, so whether a discarded render reaches the screen needs a real device.
 * See `src/testing/viewport.ts`.
 */
const useIsMobile = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export default useIsMobile;
