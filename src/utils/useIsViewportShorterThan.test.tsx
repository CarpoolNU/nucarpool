/**
 * The height half of the breakpoint, added by SCRUM-484.
 *
 * `useIsMobile` branches on width alone, which is what handed a landscape
 * phone - 667x375, above the width breakpoint - the full admin console into a
 * content row 343px tall. This hook is the opt-in alternative SCRUM-474
 * established: a caller passes its own derived threshold, and no existing
 * layout moves.
 *
 * The structure below deliberately mirrors `useIsMobile.test.tsx`, including
 * its first-render and listener-balance cases, because the two hooks are read
 * together at `/admin` and the failure modes are the same ones. Two of those
 * cases are worth reading that file's comments for rather than repeating here:
 * why the listener assertion is a *net* count under StrictMode, and why
 * dispatching a resize after unmount proves nothing.
 *
 * **What none of this covers.** jsdom does no layout, so nothing here can say
 * that 8.5% of 375px is 31.88px or that a 600px chart overflows a 343px row.
 * Those were measured in Chromium through `scripts/measure-layout.ts` and are
 * recorded on the `admin-console-chart-fold` fixture. What is assertable is
 * the gate: which threshold is read, which side of it a viewport falls on, and
 * that a rotation is noticed. See `src/testing/viewport.ts`.
 */

import { render, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "react";
import useIsViewportShorterThan from "./useIsViewportShorterThan";
import { ADMIN_CONSOLE_MIN_HEIGHT_PX } from "./breakpoints";
import {
  resizeViewportTo as resize,
  restoreViewportAfterEach,
  setViewportHeight,
  setViewportWidth,
} from "../testing/viewport";

restoreViewportAfterEach();

/** A landscape phone, which is the viewport this hook exists for. */
const LANDSCAPE_PHONE = { width: 667, height: 375 };

/** The same phone rotated back, which is comfortably above any threshold. */
const PORTRAIT_PHONE = { width: 375, height: 667 };

describe("useIsViewportShorterThan", () => {
  it("reports the viewport it mounted into", () => {
    setViewportHeight(LANDSCAPE_PHONE.height);

    const { result } = renderHook(() => useIsViewportShorterThan(600));

    expect(result.current).toBe(true);
  });

  it("reports a tall viewport as not short", () => {
    setViewportHeight(900);

    const { result } = renderHook(() => useIsViewportShorterThan(600));

    expect(result.current).toBe(false);
  });

  it("treats the threshold itself as tall enough, matching min-height CSS", () => {
    setViewportHeight(600);
    const { result } = renderHook(() => useIsViewportShorterThan(600));

    /* Strictly below, the same direction as `isMobileWidth` and as a
       `min-height` media query - at exactly the threshold the layout fits, so
       a hook using `<=` would withhold a layout that had the room for it. */
    expect(result.current).toBe(false);

    resize(1024, 599);
    expect(result.current).toBe(true);
  });

  it("follows a rotation in both directions", () => {
    setViewportWidth(PORTRAIT_PHONE.width);
    setViewportHeight(PORTRAIT_PHONE.height);

    const { result } = renderHook(() => useIsViewportShorterThan(600));
    expect(result.current).toBe(false);

    /* One event changing both dimensions, which is what a rotation is. A
       helper that could only move the width would let this test pass a state
       no device produces. */
    resize(LANDSCAPE_PHONE.width, LANDSCAPE_PHONE.height);
    expect(result.current).toBe(true);

    resize(PORTRAIT_PHONE.width, PORTRAIT_PHONE.height);
    expect(result.current).toBe(false);
  });

  it("answers for the threshold it was given, not a shared one", () => {
    /*
     * The parameter is the point of the hook: SCRUM-477's decision was that
     * each layout opts in at its *own* derived height, rather than the app
     * gaining a second global breakpoint. Two hooks over one viewport
     * disagreeing is the correct behaviour, and a hook that had quietly
     * closed over a constant would fail here.
     */
    setViewportHeight(500);

    const { result } = renderHook(() => ({
      short: useIsViewportShorterThan(600),
      tall: useIsViewportShorterThan(400),
    }));

    expect(result.current).toEqual({ short: true, tall: false });
  });

  it("leaves no resize listener behind when it unmounts", () => {
    const added = jest.spyOn(window, "addEventListener");
    const removed = jest.spyOn(window, "removeEventListener");

    const countFor = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter(([type]) => type === "resize").length;

    try {
      const { unmount } = renderHook(() => useIsViewportShorterThan(600));

      // Net count, not absolute, and `useIsMobile.test.tsx` explains why:
      // StrictMode mounts, cleans up and remounts, so raw counts are doubled.
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
 * The value during the **first render pass**, which is where `useIsMobile`'s
 * equivalent defect lived: its settled value was always right and its first
 * pass was always `false`, so a phone rendered the desktop branch once and
 * threw it away. `useSyncExternalStore` is what avoids that, and this pins it
 * for this hook rather than assuming it transfers.
 */
describe("useIsViewportShorterThan during the first render", () => {
  const renderProbe = (height: number) => {
    setViewportHeight(height);
    const seen: boolean[] = [];

    const Probe = () => {
      seen.push(useIsViewportShorterThan(600));
      return null;
    };

    render(<Probe />);
    return seen;
  };

  it("reports a short viewport on the first pass, with no corrective re-render", () => {
    /* De-duplicated rather than indexed, because StrictMode double-invokes
       render functions - asserting the *set* is one element is what rules out
       a second, corrective render. */
    expect([...new Set(renderProbe(LANDSCAPE_PHONE.height))]).toEqual([true]);
  });

  it("reports a tall viewport on the first pass too", () => {
    // The other side, so a hook hard-coded to `true` fails here.
    expect([...new Set(renderProbe(900))]).toEqual([false]);
  });
});

/**
 * The limit, pinned for the same reason `useIsMobile.test.tsx` pins it.
 *
 * React uses `getServerSnapshot` during hydration as well as on the server, so
 * a component already present in the server HTML renders the `false` branch
 * once before correcting. `/admin` is exactly that case - its
 * `userPermission` arrives as a `getServerSideProps` prop rather than behind
 * `ssr: false` - which is why its gate is paired with `useIsHydrated` instead
 * of being trusted on the first pass.
 *
 * If this starts failing, React got better: check whether `/admin` still needs
 * that pairing.
 */
describe("useIsViewportShorterThan under hydration", () => {
  it("starts from the server snapshot, so one tall pass survives", async () => {
    setViewportHeight(LANDSCAPE_PHONE.height);
    const seen: boolean[] = [];

    const Probe = () => {
      const isShort = useIsViewportShorterThan(600);
      seen.push(isShort);
      return <div>{isShort ? "short" : "tall"}</div>;
    };

    /*
     * `getServerSnapshot`'s output: the tall branch, whatever the device.
     *
     * Asserted before hydrating, because it is what makes the container built
     * below a faithful copy of the server's HTML rather than a guess at it.
     */
    expect(renderToString(<Probe />)).toBe("<div>tall</div>");

    /* Built with `createElement` rather than assigned through `innerHTML`,
       which this repo's lint bans outright - `useIsMobile.test.tsx` carries
       the same construction and the reasoning for why the two are equivalent
       for a single text-carrying div. */
    const container = document.createElement("div");
    const serverRendered = document.createElement("div");
    serverRendered.textContent = "tall";
    container.appendChild(serverRendered);
    document.body.appendChild(container);

    seen.length = 0;
    const consoleError = jest.spyOn(console, "error").mockImplementation();

    try {
      await act(async () => {
        hydrateRoot(container, <Probe />);
      });

      /* `[false, …, true]`: the server snapshot, then the real viewport. Not
         `[true]`, which is what a fresh mount gives and what the tests above
         cover. */
      expect(seen[0]).toBe(false);
      expect(seen[seen.length - 1]).toBe(true);

      // It does settle correctly, which is what keeps this from being a live
      // bug rather than merely an unfixed one.
      expect(container.textContent).toBe("short");
    } finally {
      consoleError.mockRestore();
      document.body.removeChild(container);
    }
  });
});

/**
 * That the threshold `/admin` passes is the derived one and not a literal.
 *
 * A thin assertion on its own, and it is here for a specific reason: the
 * ticket's acceptance criteria require that any new threshold be derived at
 * its own call site rather than copied, and SCRUM-474's 844px sitting in
 * `admin.tsx` would satisfy every other test in this file.
 */
describe("the threshold /admin reads", () => {
  it("is composed from the console's own numbers", () => {
    /* 500px shortest chart plus the 32px of `py-4` around the scroll port,
       over the content row's share of the viewport. That share is the
       complement of the header bar, which since SCRUM-496 has a 44px floor -
       but this threshold is above the height where the floor binds, so the
       figure is unmoved. `breakpoints.test.ts` holds the
       composition; this records the value a reviewer can check the
       measurements against. Both terms were a description of intent rather
       than of the page until SCRUM-488: the chart was shrunk below its 500 and
       the 32px was a margin that took nothing out of the row. */
    expect(ADMIN_CONSOLE_MIN_HEIGHT_PX).toBe(582);
  });

  it("puts every landscape phone below it and every desktop window above", () => {
    /*
     * The bounds the figure was accepted against, since the arithmetic alone
     * cannot say whether the answer is usable. 430 is the tallest phone in
     * landscape (a 932x430 iPhone); 650 is about what a 1366x768 laptop
     * leaves after browser chrome, and is the viewport that must keep its
     * console.
     */
    expect(ADMIN_CONSOLE_MIN_HEIGHT_PX).toBeGreaterThan(430);
    expect(ADMIN_CONSOLE_MIN_HEIGHT_PX).toBeLessThan(650);
  });
});
