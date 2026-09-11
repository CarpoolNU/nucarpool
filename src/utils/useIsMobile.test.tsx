/**
 * The first *effect* test in this repository.
 *
 * `isMobileWidth` has been unit tested since the breakpoint was unified, but
 * the hook around it never has - and its own source says why: "the hook needs
 * a DOM and this repo has no jsdom environment configured". That is what this
 * ticket removes, so the untested half is tested here.
 *
 * The half that was untested is also the half that broke. `useIsMobile` and
 * `Header` used to disagree about where mobile ended (640 vs 768), leaving
 * every viewport between them with a desktop layout and a mobile bottom bar at
 * once. `breakpoints.test.ts` guards the constant; nothing guarded that the
 * hook reads the viewport at all, reacts when it changes, or stops listening
 * when it unmounts.
 *
 * On that last one, the balance of add/remove calls is the assertion and the
 * obvious alternative is not. Dispatching a resize *after* unmount and
 * checking the value did not change proves nothing: React 19 discards a
 * `setState` from an unmounted component silently and no longer warns, and
 * Testing Library freezes `result.current` at unmount anyway - so a version of
 * this hook with its cleanup deleted passes that test. It was written, it
 * survived the mutation, and it is gone.
 */

import { render, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import useIsMobile from "./useIsMobile";
import { MOBILE_BREAKPOINT_PX } from "./breakpoints";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  resizeViewportTo as resize,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";

/**
 * The viewport technique this file used to carry inline now lives in
 * `testing/viewport.ts`, which also documents what jsdom can and cannot tell
 * you about a mobile layout. It was copied into two other files
 * before it was shared.
 */
restoreViewportAfterEach();

describe("useIsMobile", () => {
  it("reports the viewport it mounted into, not its initial false", () => {
    setViewportWidth(375);

    const { result } = renderHook(() => useIsMobile());

    // `useState(false)` is the pre-effect value. Asserting `true` here is
    // asserting that the mount effect ran and its state landed - a hook that
    // only checked on resize would pass a lint and fail this.
    expect(result.current).toBe(true);
  });

  it("reports a desktop viewport as not mobile", () => {
    setViewportWidth(1440);

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it("follows the viewport across the breakpoint in both directions", () => {
    setViewportWidth(1440);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    resize(375);
    expect(result.current).toBe(true);

    resize(1440);
    expect(result.current).toBe(false);
  });

  it("treats the breakpoint itself as desktop, matching min-width CSS", () => {
    setViewportWidth(MOBILE_BREAKPOINT_PX);
    const { result } = renderHook(() => useIsMobile());

    // Tailwind's `desktop:` utilities are min-width, so they apply *at* the
    // boundary. A hook using `<=` here would put the layout and the CSS on
    // opposite sides of one pixel.
    expect(result.current).toBe(false);

    resize(MOBILE_BREAKPOINT_PX - 1);
    expect(result.current).toBe(true);
  });

  it("leaves no resize listener behind when it unmounts", () => {
    const added = jest.spyOn(window, "addEventListener");
    const removed = jest.spyOn(window, "removeEventListener");

    const countFor = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter(([type]) => type === "resize").length;

    try {
      const { unmount } = renderHook(() => useIsMobile());

      // Net count, not absolute: `jest.setup.dom.ts` renders every component
      // test inside StrictMode, which mounts, cleans up and remounts, so the
      // raw call counts are doubled and asserting on them would be asserting
      // on StrictMode. What matters is the balance.
      expect(countFor(added) - countFor(removed)).toBe(1);

      unmount();

      expect(countFor(added) - countFor(removed)).toBe(0);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
  });
});

/**
 * What the value is during the **first render pass**, rather than after
 * effects have flushed.
 *
 * Every test above reads `result.current`, which Testing Library exposes only
 * once rendering has settled. That is exactly why the defect this describes
 * went unseen for as long as it did: the hook's *settled* value was always
 * right, and its first-pass value was always `false`. The suite's opening test
 * is even named "not its initial false", so the initial value was known - what
 * nothing checked was what got rendered while it held.
 *
 * These record the value from inside the render function instead, which is the
 * only place the difference is observable.
 */
describe("useIsMobile during the first render", () => {
  /**
   * Collects the value each time the probe's render function runs.
   *
   * Asserted as a de-duplicated set rather than by index, because
   * `jest.setup.dom.ts` renders every component test inside StrictMode and
   * StrictMode double-invokes render functions. Asserting `seen[0]` would pass
   * for the old hook too if the doubling happened to interleave; asserting
   * that the *set* of observed values is a single element is what rules out a
   * corrective second render.
   */
  const renderProbe = (width: number) => {
    setViewportWidth(width);
    const seen: boolean[] = [];

    const Probe = () => {
      seen.push(useIsMobile());
      return null;
    };

    render(<Probe />);
    return seen;
  };

  it("reports mobile on the first pass, with no corrective re-render", () => {
    // The whole ticket. Against `useState(false)` plus a mount effect this
    // observes `[false, …, true]` - the desktop branch rendered once on a
    // phone, which is what mounted `DropDownMenu` and fired a presigned-URL
    // request for an avatar no mobile visitor sees.
    expect([...new Set(renderProbe(MOBILE_WIDTH))]).toEqual([true]);
  });

  it("reports desktop on the first pass too", () => {
    // The other side, so a hook hard-coded to `true` fails. Desktop was never
    // broken here - `false` was already right on the first pass - so this
    // pins that the fix did not buy mobile correctness with a desktop
    // regression.
    expect([...new Set(renderProbe(DESKTOP_WIDTH))]).toEqual([false]);
  });
});

/**
 * The limit of the fix, pinned rather than described.
 *
 * React uses `getServerSnapshot` during **hydration** as well as during server
 * rendering, so a component that is already in the server HTML still renders
 * its desktop branch once on a phone before correcting. That is a property of
 * React rather than of this hook, and the ticket's own proposed fix assumed
 * the opposite - it claimed the client's first render would be correct, full
 * stop.
 *
 * This test exists so that assumption cannot be made again from reading the
 * hook, and so that a React release which *changed* the behaviour would say so
 * out loud rather than silently making the comments in `useIsMobile.ts` wrong.
 * If it starts failing, the fix got better: check whether `/admin` still needs
 * its own treatment.
 *
 * Deliberately not using Testing Library's `render`, which mounts fresh -
 * mounting fresh is the case that already works and is covered above.
 */
describe("useIsMobile under hydration", () => {
  it("still starts from the server snapshot, so one desktop pass survives", async () => {
    setViewportWidth(MOBILE_WIDTH);
    const seen: boolean[] = [];

    const Probe = () => {
      const isMobile = useIsMobile();
      seen.push(isMobile);
      return <div>{isMobile ? "mobile" : "desktop"}</div>;
    };

    /*
     * `getServerSnapshot`'s output: the desktop branch, whatever the device.
     *
     * This is also the assertion that catches the naive fix the ticket warns
     * about. A hook reading `window.innerWidth` in a `useState` initialiser
     * renders "mobile" here and fails - **but not for the reason it would fail
     * in production.** jsdom always has a `window`, so `renderToString` under
     * this test environment is not a faithful server: a `typeof window` guard
     * takes its client branch. In real SSR the server would emit "desktop" and
     * the client's first render would say "mobile", which is the mismatch. Here
     * both say "mobile" and there is no mismatch to observe.
     */
    expect(renderToString(<Probe />)).toBe("<div>desktop</div>");

    /*
     * Built with `createElement` rather than assigned through `innerHTML`,
     * which this repo's lint bans outright. For a single text-carrying div the
     * two produce identical DOM - the `renderToString` assertion above is what
     * pins that equivalence, and the absence of a hydration warning below is
     * what confirms React agrees.
     */
    const container = document.createElement("div");
    const serverRendered = document.createElement("div");
    serverRendered.textContent = "desktop";
    container.appendChild(serverRendered);
    document.body.appendChild(container);

    seen.length = 0;
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    try {
      await act(async () => {
        hydrateRoot(container, <Probe />);
      });

      // Desktop first, then corrected - the discarded render this ticket is
      // about, still present on a subtree that hydrates rather than mounts.
      expect(seen[0]).toBe(false);
      expect(seen[seen.length - 1]).toBe(true);

      // It does settle correctly, which is what keeps this from being a live
      // bug rather than merely an unfixed one.
      expect(container.textContent).toBe("mobile");

      /*
       * That *this* hydration is clean - no more than that.
       *
       * It is not the ticket's "no hydration warning" criterion, and cannot
       * be: as noted above, jsdom cannot produce a windowless server render,
       * so the SSR-versus-client divergence that generates a real mismatch is
       * unreachable from here. What this rules out is React complaining about
       * the hydration performed in this test. The criterion itself needs a
       * browser console on a page served by `getServerSideProps`.
       */
      const hydrationComplaints = consoleError.mock.calls.filter((call) =>
        JSON.stringify(call).toLowerCase().includes("hydrat"),
      );
      expect(hydrationComplaints).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
