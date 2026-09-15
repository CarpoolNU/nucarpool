import { useSyncExternalStore } from "react";

/**
 * Subscribe to viewport changes.
 *
 * Module scope for the same reason `useIsMobile`'s twin is: React resubscribes
 * whenever this function's identity changes, so a closure created per render
 * would tear the listener down and re-add it on every render of every
 * consumer.
 *
 * `resize` is the right event and `orientationchange` is deliberately not also
 * listened for. Every browser fires `resize` when the viewport changes shape,
 * a rotation included, and adding the second listener would only produce two
 * notifications for one rotation.
 */
const subscribe = (onStoreChange: () => void) => {
  window.addEventListener("resize", onStoreChange);

  return () => {
    window.removeEventListener("resize", onStoreChange);
  };
};

/**
 * What the server must render, and therefore what hydration must start from.
 *
 * `false` - "not short", the desktop assumption - because there is no `window`
 * on the server and no way to know the viewport. Identical in both value and
 * reasoning to `useIsMobile`'s server snapshot, and identical for a reason
 * worth keeping: the two hooks are read together at `/admin`, and a pair of
 * gates that disagreed about what the server renders would produce a hydration
 * mismatch in whichever direction they differed.
 */
const getServerSnapshot = () => false;

/**
 * Whether the viewport is shorter than `minHeightPx`.
 *
 * **The height half of the breakpoint, kept out of `useIsMobile` on purpose.**
 * SCRUM-477 records why `MOBILE_BREAKPOINT_PX` does not gain a height term:
 * it is read by `useIsMobile`, by `tailwind.config.js`, by the `desktop:`
 * screen and by `DESKTOP_MEDIA_QUERY`, so a height there would move every page
 * across the line at once. This is the opt-in alternative SCRUM-474
 * established, in the shape a page needs when the branch cannot be CSS - a
 * caller passes its *own* derived threshold and nothing else is affected.
 *
 * **Why a hook and not a `desktop-tall:`-style screen.** The admin console's
 * branch decides which subtree *mounts*, not which classes apply. Rendering
 * both and hiding one in CSS would mount the console on a landscape phone and
 * fire its `getAllUsers` query there, which is the request SCRUM-452 went to
 * some trouble to stop firing on a render that gets discarded.
 *
 * **Why `useSyncExternalStore` and not `useState` plus an effect**, and what
 * it does not buy: exactly as written at length in `useIsMobile`. Read that
 * module before changing this one. The short version is that an effect renders
 * the wrong branch once and throws it away, reading `window` in a `useState`
 * initialiser trades that for a hydration mismatch, and this shape avoids
 * both - but React uses `getServerSnapshot` during hydration too, so a
 * component already in the server HTML still renders the `false` branch once
 * before correcting. `/admin` is precisely that case, which is why its gate is
 * paired with `useIsHydrated` rather than trusted on the first pass.
 *
 * The threshold is a parameter rather than a constant because there is no one
 * right height: it is a property of the layout asking, the way
 * `WIZARD_DESKTOP_MIN_HEIGHT_PX` and `ADMIN_CONSOLE_MIN_HEIGHT_PX` are each
 * derived from their own arrangement. Passing a literal here would be the
 * mistake SCRUM-484's ticket calls out - copying the wizard's 844px to a place
 * it means nothing.
 *
 * `getSnapshot` is rebuilt per render, which `useSyncExternalStore` allows: it
 * compares snapshots with `Object.is`, and a boolean is equal to itself by
 * value. The closure over `minHeightPx` is what makes the parameter work, and
 * it costs nothing because the *value* is stable even though the function is
 * not.
 *
 * Strictly below the threshold, matching `isMobileWidth` and CSS `min-height`
 * semantics: at exactly `minHeightPx` the layout fits, so this must be false.
 */
const useIsViewportShorterThan = (minHeightPx: number): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.innerHeight < minHeightPx,
    getServerSnapshot,
  );

export default useIsViewportShorterThan;
