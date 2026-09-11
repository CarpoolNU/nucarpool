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
 * The single source of "is this a mobile viewport".
 *
 * `Header` used to run its own `<= 768` check that disagreed with this one,
 * producing a desktop layout wearing the mobile navigation between the two
 * values. One definition, in `utils/breakpoints.js`.
 *
 * **Why `useSyncExternalStore` and not `useState` plus an effect.** An effect
 * runs *after* the render that scheduled it, so a `useState(false)` hook renders
 * the desktop branch once on a phone and throws it away — and for `Header` that
 * was not free, because the desktop branch mounts `DropDownMenu`, which fires an
 * authenticated presigned-URL request for an avatar no mobile visitor sees.
 * Reading `window.innerWidth` in a `useState` initialiser is the obvious fix and
 * the wrong one: the server cannot produce that value, so it trades the wasted
 * render for a hydration mismatch. This shape does not have to choose —
 * `getServerSnapshot` keeps the server and hydration agreeing, `getSnapshot`
 * makes any other first render correct.
 *
 * **What that does not buy.** React uses `getServerSnapshot` during *hydration*
 * as well as on the server, so a component already in the server HTML still
 * renders its desktop branch once before correcting. Probed under `hydrateRoot`
 * at a mobile width the sequence is `[false, true]`; a fresh client mount is
 * `[true]`. So this fixes any subtree that mounts after hydration and does not
 * fix one that hydrates. `trpc` is configured `ssr: false`, so `/` and
 * `/profile` return a spinner until `user.me` resolves and their `Header`
 * mounts fresh; `/sign-in` never renders `DropDownMenu`. `/admin` was the
 * exception and is now handled with `useIsHydrated` — see that module.
 *
 * Whether a discarded render reaches the screen needs a real device; jsdom does
 * not paint. See `src/testing/viewport.ts`.
 */
const useIsMobile = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

export default useIsMobile;
