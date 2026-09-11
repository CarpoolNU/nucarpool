/**
 * Rendering a component test at a mobile viewport.
 *
 * jsdom reports a fixed `innerWidth` and never changes it, so the viewport has
 * to be written with `Object.defineProperty`. Three suites had each re-derived
 * that before this existed, with cleanup in only one.
 *
 * ---
 *
 * **Read this before trusting a green run on anything about mobile.** jsdom
 * does no layout and evaluates no CSS. Each of the following was measured here
 * rather than assumed:
 *
 *  - **No geometry.** An element with an explicit width and height still
 *    reports `getBoundingClientRect()` of all zeros and `offsetHeight` of `0`.
 *    jsdom cannot tell you that a fixed bar overlaps anything.
 *  - **`getComputedStyle` is the trap, not the escape hatch.** For an *inline*
 *    style it echoes the declared value back and computes nothing, which looks
 *    like a measurement and is not one. It *does* resolve a stylesheet
 *    styled-components injects, which is a real capability.
 *  - **No media queries.** A `desktop:` utility is inert, and `matchMedia` is
 *    **absent** rather than stubbed, so a component written against it would
 *    throw here. Setting the width below only reaches code reading
 *    `window.innerWidth`.
 *  - **No units, and `env()` is mangled.** `100dvh` stays unresolved, and
 *    jsdom's parser rewrites `calc(60px + env(safe-area-inset-bottom, 0px))`
 *    with the fallback and variable swapped. Safe-area behaviour needs a real
 *    device; nothing here can assert it.
 *  - **No paint order.** `z-index` is not computed, so "the sheet covers the
 *    panel" is not observable -- only "the sheet is in the tree".
 *  - **No `PointerEvent`, and the failure is silent.** `typeof
 *    window.PointerEvent` is `"undefined"` in jsdom 26, so
 *    `fireEvent.pointerDown(el, { clientY: 300 })` falls back to a bare
 *    `Event` and **drops `clientY`**. A drag test written that way computes
 *    `NaN`, writes a height the DOM discards, and still passes several of its
 *    assertions. Construct a `MouseEvent` named `pointerdown` instead -- React
 *    dispatches by event name -- and define `pointerId` onto the instance.
 *    `useSheetDrag.test.tsx` carries the helper. `touch-action` is likewise
 *    unimplemented, so "the browser does not claim this gesture" is not
 *    assertable here at all.
 *
 * So these tests can assert **reachability and wiring**: whether a control
 * exists at a given width, and what happens when it is activated. That is not
 * layout coverage, and a green `yarn test` must not be read as any. See
 * `docs/testing.md`, which also covers the two-timezone CI run.
 */

import { act } from "@testing-library/react";
import { MOBILE_BREAKPOINT_PX } from "../utils/breakpoints";

/**
 * Strictly below the breakpoint. `isMobileWidth` is `width < BREAKPOINT`, so
 * this is the widest viewport that still counts as mobile — the boundary is
 * more useful as a default than a round 375, because an off-by-one in the
 * comparison shows up here and would not at 375.
 */
export const MOBILE_WIDTH = MOBILE_BREAKPOINT_PX - 1;

/**
 * The narrowest viewport that is *not* mobile. At exactly the breakpoint the
 * `desktop:` utilities apply, so this is the low end of desktop rather than
 * some comfortable 1440 — same reasoning as `MOBILE_WIDTH`.
 */
export const DESKTOP_WIDTH = MOBILE_BREAKPOINT_PX;

/**
 * jsdom reports `innerWidth: 1024` and never changes it, so the viewport has
 * to be written directly.
 *
 * `defineProperty` rather than plain assignment because the DOM types declare
 * `innerWidth` readonly; jsdom leaves it configurable, which is what makes
 * this work at all.
 *
 * This does **not** dispatch a `resize` event — mount-time reads see it, but a
 * component already mounted will not notice. Use `resizeViewportTo` for that.
 */
export const setViewportWidth = (width: number) => {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    writable: true,
    configurable: true,
  });
};

/**
 * Change the viewport of an already-mounted tree and let React process the
 * resulting state update.
 *
 * Wrapped in `act` because `useIsMobile`'s listener calls `setState`: without
 * it the update lands outside React's batching and the assertion races the
 * re-render.
 */
export const resizeViewportTo = (width: number) => {
  act(() => {
    setViewportWidth(width);
    window.dispatchEvent(new Event("resize"));
  });
};

/**
 * Restore the width this file's jsdom instance started with, after each test.
 *
 * Each test *file* gets its own jsdom, so a width set in one file cannot leak
 * into another — but within a file it persists across tests, and that is a
 * real trap: a `describe` block that assumes the default 1024 passes or fails
 * depending on which block ran before it. Two of the three call sites this
 * helper replaced had no cleanup at all.
 *
 * Call at the top level of a test file, outside any `describe`.
 */
export const restoreViewportAfterEach = () => {
  const originalWidth = window.innerWidth;

  afterEach(() => {
    setViewportWidth(originalWidth);
  });
};
