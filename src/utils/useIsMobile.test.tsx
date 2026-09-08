/**
 * The first *effect* test in this repository (SCRUM-377).
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

import { act, renderHook } from "@testing-library/react";
import useIsMobile from "./useIsMobile";
import { MOBILE_BREAKPOINT_PX } from "./breakpoints";

/**
 * jsdom reports `innerWidth: 1024` and never changes it, so the viewport has
 * to be written directly. `defineProperty` rather than assignment because the
 * DOM types declare it readonly, and jsdom leaves it configurable.
 */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    writable: true,
    configurable: true,
  });
};

const resize = (width: number) => {
  act(() => {
    setViewportWidth(width);
    window.dispatchEvent(new Event("resize"));
  });
};

const originalWidth = window.innerWidth;

afterEach(() => {
  setViewportWidth(originalWidth);
});

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
