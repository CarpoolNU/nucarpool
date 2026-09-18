/**
 * The regression guard for the map's lifecycle.
 *
 * `index.tsx` built its `mapboxgl.Map` in a `useEffect` that returned no
 * cleanup, so every unmount left a live WebGL context, six `map.on` listeners
 * and a `NavigationControl` behind. The page has no test - its own comments
 * cite that as the reason decisions keep getting lifted out of it - so the
 * lifecycle was lifted here, where it can be asserted.
 *
 * What jsdom can and cannot prove matters here. There is no WebGL and no real
 * context, so "ten navigations leave one live context" is not assertable in
 * this file; that check needs a device and is recorded on the PR. What *is*
 * assertable is the half that actually regressed: that `remove()` is called,
 * that it is called exactly once per map, and - the failure mode the naive fix
 * introduces - that a `user.me` refetch does not tear a live map down and
 * build another one.
 */

import { act, renderHook } from "@testing-library/react";

/**
 * A fake `Map` rather than the real one: `mapbox-gl` needs WebGL, which jsdom
 * does not have, and the assertions here are all about *which* methods this
 * hook calls and when - not about what Mapbox does with them.
 */
jest.mock("mapbox-gl", () => {
  class FakeMap {
    static instances: FakeMap[] = [];

    options: Record<string, unknown>;
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    remove = jest.fn();
    resize = jest.fn();
    setMaxZoom = jest.fn();
    setMinZoom = jest.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeMap.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      (this.handlers[event] ??= []).push(handler);
      return this;
    }

    /** Stand-in for Mapbox finishing its initial style and tile load. */
    fire(event: string) {
      (this.handlers[event] ?? []).forEach((handler) => handler());
    }
  }

  return { __esModule: true, default: { Map: FakeMap }, Map: FakeMap };
});

const { Map: FakeMap } = jest.requireMock("mapbox-gl");

/**
 * A fake `ResizeObserver`, because jsdom does not implement one at all -
 * `typeof window.ResizeObserver` is `"undefined"` here, so `useMapResize`
 * would throw the instant a test rendered it without this.
 *
 * Real box measurement is not the point of these tests, and jsdom could not
 * give one anyway (`src/testing/viewport.ts` documents that jsdom does no
 * layout). `trigger()` stands in for the browser deciding the observed
 * element's box changed, which is the one thing these tests need to control.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];

  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  /** Simulates the browser reporting the observed element's box changed. */
  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

(global as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

const lastObserver = (): FakeResizeObserver => {
  const all = FakeResizeObserver.instances;
  const observer = all[all.length - 1];
  if (!observer) throw new Error("no ResizeObserver was constructed");
  return observer;
};

import { useMapInstance, useMapResize } from "./useMapInstance";

type FakeMapInstance = {
  options: Record<string, unknown>;
  remove: jest.Mock;
  resize: jest.Mock;
  setMaxZoom: jest.Mock;
  setMinZoom: jest.Mock;
  fire: (event: string) => void;
};

const instances = (): FakeMapInstance[] => FakeMap.instances;

/**
 * The maps that have been built and not destroyed - the closest this
 * environment gets to the acceptance criterion, which counts live WebGL
 * contexts. Constructions alone are the wrong measure: these tests run under
 * StrictMode, which mounts, tears down and remounts every effect, so a correct
 * hook builds two maps here and keeps one. Counting constructions would fail a
 * working hook; counting survivors is what the leak was about.
 */
const liveInstances = (): FakeMapInstance[] =>
  instances().filter((map) => map.remove.mock.calls.length === 0);

const lastInstance = (): FakeMapInstance => {
  const all = instances();
  const map = all[all.length - 1];
  if (!map) throw new Error("no map was constructed");
  return map;
};

/**
 * A mounted container, because the hook refuses to build into nothing. Built
 * once per test rather than inline in the hook body: a fresh ref object on
 * every render is not what `useRef` hands `index.tsx`, and a hook that rebuilt
 * its map whenever that identity changed would still pass a test that gave it
 * a new one each render.
 */
let containerRef: { current: HTMLElement | null };

beforeEach(() => {
  FakeMap.instances = [];
  // Not `innerHTML = ""`: assigning markup is banned repo-wide, and this only
  // needs the previous test's container gone.
  document.body.replaceChildren();
  const element = document.createElement("div");
  element.id = "map";
  document.body.appendChild(element);
  containerRef = { current: element };
});

describe("useMapInstance", () => {
  it("does not build a map before the centre is known", () => {
    renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: null,
      }),
    );

    expect(instances()).toHaveLength(0);
  });

  it("builds the map at the centre it was given", () => {
    renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [-71.088748, 42.33907],
      }),
    );

    expect(liveInstances()).toHaveLength(1);
    expect(lastInstance().options).toMatchObject({
      container: "map",
      center: [-71.088748, 42.33907],
    });
  });

  it("publishes the map only once Mapbox reports it loaded", () => {
    const { result } = renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [0, 0],
      }),
    );

    expect(result.current.map).toBeUndefined();
    expect(result.current.isLoaded).toBe(false);

    act(() => lastInstance().fire("load"));

    expect(result.current.map).toBe(lastInstance());
    expect(result.current.isLoaded).toBe(true);
  });

  it("runs onLoad with the map once it has loaded", () => {
    const onLoad = jest.fn();
    renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [0, 0],
        onLoad,
      }),
    );

    expect(onLoad).not.toHaveBeenCalled();

    act(() => lastInstance().fire("load"));

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledWith(lastInstance());
  });

  /**
   * The white-box-below-the-map bug (SCRUM-534): with no floor, a user could
   * zoom out past the point where Mapbox's rendered world still fills the
   * container, exposing blank canvas past the latitude clamp.
   */
  it("caps how far the map can be zoomed out, by default", () => {
    renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [0, 0],
      }),
    );

    act(() => lastInstance().fire("load"));

    expect(lastInstance().setMinZoom).toHaveBeenCalledWith(3);
  });

  it("honours a caller-supplied zoom-out floor", () => {
    renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [0, 0],
        minZoom: 5,
      }),
    );

    act(() => lastInstance().fire("load"));

    expect(lastInstance().setMinZoom).toHaveBeenCalledWith(5);
  });

  it("destroys the map when the page unmounts", () => {
    const { unmount } = renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [0, 0],
      }),
    );

    act(() => lastInstance().fire("load"));
    const map = lastInstance();

    expect(map.remove).not.toHaveBeenCalled();

    unmount();

    expect(map.remove).toHaveBeenCalledTimes(1);
    expect(liveInstances()).toHaveLength(0);
  });

  /**
   * The failure mode of the obvious fix.
   *
   * The effect this replaces depended on `[mapContainerRef, user]` and was
   * kept to one map by a `useRef` flag. Hanging a `remove()` cleanup off that
   * effect unchanged would destroy and rebuild the map on every `user.me`
   * refetch, because react-query hands back a new object each time - losing
   * the viewport, the drawn route and every marker on it.
   */
  it("keeps one map across re-renders that change nothing it was built from", () => {
    const { rerender } = renderHook(
      ({ onLoad }: { onLoad: jest.Mock }) =>
        useMapInstance({
          containerId: "map",
          containerRef,
          center: [-71.088748, 42.33907],
          onLoad,
        }),
      { initialProps: { onLoad: jest.fn() } },
    );

    act(() => lastInstance().fire("load"));
    const map = lastInstance();

    // A fresh `onLoad` identity is what a `user.me` refetch produces.
    rerender({ onLoad: jest.fn() });
    rerender({ onLoad: jest.fn() });

    expect(liveInstances()).toEqual([map]);
    expect(map.remove).not.toHaveBeenCalled();
  });

  it("ignores a load that arrives after the page has gone", () => {
    const onLoad = jest.fn();
    const { unmount } = renderHook(() =>
      useMapInstance({
        containerId: "map",
        containerRef,
        center: [0, 0],
        onLoad,
      }),
    );

    const map = lastInstance();
    unmount();
    act(() => map.fire("load"));

    expect(onLoad).not.toHaveBeenCalled();
  });
});

describe("useMapResize", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    FakeResizeObserver.instances = [];
  });
  afterEach(() => jest.useRealTimers());

  /** A burst of the observer reporting the same element's box repeatedly. */
  const triggerObserver = (times: number) => {
    for (let i = 0; i < times; i++) {
      lastObserver().trigger();
    }
  };

  it("sizes the map once on mount", () => {
    const map = new FakeMap({});
    renderHook(() => useMapResize(map, containerRef));

    act(() => {
      jest.runAllTimers();
    });

    expect(map.resize).toHaveBeenCalledTimes(1);
  });

  it("observes the map's own container, not some other element", () => {
    const map = new FakeMap({});
    renderHook(() => useMapResize(map, containerRef));

    expect(lastObserver().observe).toHaveBeenCalledWith(containerRef.current);
  });

  /**
   * iOS Safari fires this on every URL-bar collapse and expand during an
   * ordinary scroll - dozens of times in a few seconds. Each one used to queue
   * its own `setTimeout`, and each of those a full WebGL canvas resize and
   * tile repaint.
   */
  it("collapses a burst of container-resize reports into one map resize", () => {
    const map = new FakeMap({});
    renderHook(() => useMapResize(map, containerRef));

    act(() => {
      jest.runAllTimers();
    });
    map.resize.mockClear();

    act(() => {
      triggerObserver(20);
      jest.runAllTimers();
    });

    expect(map.resize).toHaveBeenCalledTimes(1);
  });

  /**
   * The case a `window` `resize` listener could not see at all: the
   * container's own box changing for a reason - a mobile/desktop layout flip,
   * the dynamic-viewport reflow this file's docblock describes - that never
   * dispatches one.
   */
  it("re-sizes when the container's own box changes, with no window resize event", () => {
    const map = new FakeMap({});
    renderHook(() => useMapResize(map, containerRef));

    act(() => {
      jest.runAllTimers();
    });
    map.resize.mockClear();

    act(() => {
      lastObserver().trigger();
      jest.runAllTimers();
    });

    expect(map.resize).toHaveBeenCalledTimes(1);
  });

  it("does not resize a map that has already been destroyed", () => {
    const map = new FakeMap({});
    const { unmount } = renderHook(() => useMapResize(map, containerRef));

    act(() => {
      jest.runAllTimers();
    });
    map.resize.mockClear();

    // The burst and the unmount race on a real device: the debounce is still
    // pending when React tears the page down, and the map is removed first.
    triggerObserver(5);
    unmount();
    act(() => {
      jest.runAllTimers();
    });

    expect(map.resize).not.toHaveBeenCalled();
  });

  it("disconnects the observer on unmount", () => {
    const map = new FakeMap({});
    const { unmount } = renderHook(() => useMapResize(map, containerRef));

    act(() => {
      jest.runAllTimers();
    });

    unmount();

    expect(lastObserver().disconnect).toHaveBeenCalledTimes(1);
  });
});
