/**
 * Rendering a component test at a mobile viewport.
 *
 * Three files had each re-derived the same `Object.defineProperty` incantation
 * before this existed — `useIsMobile.test.tsx`, `ExploreSidebar.test.tsx` and
 * `GroupPage.test.tsx` — with the reason for it written out twice and the
 * cleanup present in only one of them. This is that technique, once.
 *
 * ---
 *
 * **Read this before trusting a green run on anything about mobile.**
 *
 * jsdom does not do layout and does not evaluate CSS. What that rules out is
 * most of what "mobile is broken" usually means. Each of the following was
 * measured in this jsdom rather than assumed:
 *
 *  - **No geometry.** A div with an explicit `width: 200px; height: 100px`
 *    still reports `getBoundingClientRect()` of all zeros and `offsetHeight`
 *    of `0`. jsdom cannot tell you that a 60px fixed bar overlaps an element
 *    positioned 48px from the bottom, which is the whole point.
 *  - **`getComputedStyle` is the trap, not the escape hatch.** For that same
 *    div it returns `height: "100px"` — it echoes the declared value back and
 *    computes nothing. It looks like a measurement and is not one, which
 *    makes it more dangerous than the honest zeros above. Do not reach for it
 *    to assert layout.
 *  - **No media queries.** A `desktop:` utility is inert here, and
 *    `window.matchMedia` is `undefined` — not stubbed, absent. A component
 *    written against it instead of `useIsMobile` would throw in these tests
 *    without a polyfill. Setting the width below only reaches code that reads
 *    `window.innerWidth`.
 *  - **No units, and `env()` is actively mangled.** `getComputedStyle` on
 *    `height: 100dvh` returns the literal string `"100dvh"`, unresolved. And
 *    jsdom's CSS parser *rewrites* `calc(60px + env(safe-area-inset-bottom,
 *    0px))` into `calc(60px + env(0px * , * safe-area-inset-bottom))` — the
 *    fallback and the variable swap places. So an assertion on a style string
 *    containing `env()` tests jsdom's parser, not the app. Safe-area
 *    behaviour needs a physical device with a home indicator; nothing in this
 *    repository can assert it.
 *  - **No paint order.** `z-index` is not computed, so "the sheet covers the
 *    message panel" is not observable — only "the sheet is in the tree".
 *  - **No honest server render, so no hydration mismatch.** jsdom always
 *    provides a `window`, so `renderToString` here is not a faithful server:
 *    a component guarding on `typeof window` takes its *client* branch and
 *    the SSR-versus-client divergence that produces a real mismatch never
 *    arises. `useIsMobile.test.tsx` does hydrate a subtree deliberately, to
 *    pin which snapshot `useSyncExternalStore` starts from — but
 *    "no hydration warning on a real page" is not assertable from here at
 *    all, and needs a browser console.
 *
 * So what these tests *can* assert is **reachability and wiring**: whether a
 * control exists in the tree at a given width, and what happens when it is
 * activated. That is exactly the class of defect phase 3 of the audit was —
 * controls that rendered on desktop and simply did not exist on mobile — and
 * it is worth guarding. It is not layout coverage, and a green `yarn test`
 * must not be read as any.
 *
 * The layout half needs a real browser at two viewports. That is that change's
 * Playwright scope, extended by this ticket to require both a mobile and a
 * desktop viewport.
 *
 * ---
 *
 * One more thing that catches people out: `test.yml` runs Jest **twice**, under
 * `UTC` and `America/New_York`. A local `yarn test` covers only the first, so a
 * date-dependent assertion can pass locally and fail in CI.
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
