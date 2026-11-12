/**
 * The sweep must unbind a pin's click listener, because the sweep is the path
 * production actually takes.
 *
 * `updateCompanyLocation`'s own `remove` branch calls `map.off` before taking
 * the layer off, and `updateCompanyLocation.clickHandler.test.tsx` holds that
 * in place. But nothing in the app calls that branch for another user's pin:
 * `viewRouteClick` and `groupRouteClick` both open by calling
 * `clearOtherUserMarkers(map)`, which finds pin layers by matching their ids
 * and calls `map.removeLayer` directly. Removing a layer does **not** remove
 * the listeners scoped to it, so before SCRUM-722 every card click left one
 * more live handler on the destination layer it rebuilt - measured in Chromium
 * against real Mapbox GL as five handler invocations from one click after four
 * cycles, against one for the updater's own branch.
 *
 * **Live listeners are counted, not calls.** A call count cannot tell one
 * surviving listener from five, which is the whole question; the fake map
 * below keeps the listeners for an event as an **array**, which is what Mapbox
 * keeps - `on` appends unconditionally and does not deduplicate. A `Set` would
 * hide the defect entirely, since the handler is the same function every time
 * and redundant binds would collapse into one entry.
 *
 * The click assertions dispatch through that same array, so "one invocation"
 * and "one live listener" are two readings of one measurement rather than two
 * independent checks. No fake can vouch for Mapbox's own delegated-listener
 * bookkeeping; this is the cheap guard, and the browser run described in the
 * SCRUM-722 PR is what actually proves the behaviour.
 *
 * A `.tsx` test deliberately, despite testing no component: drawing a pin goes
 * through `updateCompanyLocation`, which imports four PNGs, and only the jsdom
 * project maps a static image import to a stub. See the same note on
 * `updateCompanyLocation.clickHandler.test.tsx`.
 */

import clearOtherUserMarkers from "./clearOtherUserMarkers";
import updateCompanyLocation from "./updateCompanyLocation";
import { setPointClickHandler } from "./handlers";
import { Role } from "@prisma/client";

const USER_ID = "clyt9e0x40000ld19lfjt6tqy";
const LAYER_ID = `other-user-${USER_ID}-company-layer`;
const TEXT_LAYER_ID = `other-user-${USER_ID}-company-text-layer`;
const START_LAYER_ID = `other-user-${USER_ID}-start-layer`;
const START_TEXT_LAYER_ID = `other-user-${USER_ID}-start-text-layer`;

type Listener = (...args: unknown[]) => void;

/**
 * A fake map that models the listener table, the style, and the image set.
 *
 * Wider than either existing fake because this suite drives both sides of the
 * cycle: `updateCompanyLocation` needs `loadImage`/`addLayer`/`on`, and
 * `clearOtherUserMarkers` needs `getStyle`/`removeLayer`/`removeSource`.
 *
 * `layers` is an array rather than a `Set` so `getStyle()` reports them in
 * insertion order, matching the snapshot the sweep iterates. `loadImage`
 * invokes its callback synchronously, because everything the updater does to
 * the map happens inside that callback; the real one is asynchronous, which
 * does not change what gets bound.
 */
const buildMap = (seedLayers: string[] = []) => {
  const layers: string[] = [...seedLayers];
  const sources = new Map<string, { setData: jest.Mock }>();
  const images = new Set<string>();
  const listeners = new Map<string, Listener[]>();

  const key = (event: string, layerId: string) => `${event}:${layerId}`;

  const map = {
    loadImage: (_src: string, callback: (e: unknown, i: unknown) => void) =>
      callback(null, new Image()),

    getStyle: () => ({
      layers: layers.map((id) => ({ id })),
      sources: Object.fromEntries([...sources.keys()].map((id) => [id, {}])),
    }),

    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    addLayer: jest.fn((layer: { id: string }) => {
      layers.push(layer.id);
    }),
    removeLayer: jest.fn((id: string) => {
      const at = layers.indexOf(id);
      if (at !== -1) layers.splice(at, 1);
    }),

    getSource: (id: string) => sources.get(id),
    addSource: jest.fn((id: string) => {
      sources.set(id, { setData: jest.fn() });
    }),
    removeSource: jest.fn((id: string) => {
      sources.delete(id);
    }),

    hasImage: (id: string) => images.has(id),
    addImage: jest.fn((id: string) => {
      images.add(id);
    }),
    removeImage: jest.fn((id: string) => {
      images.delete(id);
    }),

    on: jest.fn((event: string, layerId: string, handler: Listener) => {
      const k = key(event, layerId);
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k)!.push(handler);
    }),
    // Mapbox removes one matching entry, not every match.
    off: jest.fn((event: string, layerId: string, handler: Listener) => {
      const bound = listeners.get(key(event, layerId));
      if (!bound) return;
      const at = bound.indexOf(handler);
      if (at !== -1) bound.splice(at, 1);
    }),
  };

  return {
    map: map as unknown as mapboxgl.Map,
    /** How many listeners are bound for one event on one layer, right now. */
    liveListeners: (event: string, layerId: string) =>
      listeners.get(key(event, layerId))?.length ?? 0,
    /** Fires every listener bound for one event on one layer, as Mapbox would. */
    fire: (event: string, layerId: string) => {
      [...(listeners.get(key(event, layerId)) ?? [])].forEach((listener) =>
        listener({ features: [] }),
      );
    },
    off: map.off,
    layers,
  };
};

/** Draws another user's pin, with a label so the text layer exists too. */
const draw = (map: mapboxgl.Map) =>
  updateCompanyLocation(
    map,
    -71.09,
    42.34,
    Role.RIDER,
    USER_ID,
    undefined,
    false,
    false,
    "Destination",
  );

describe("the pin's click listener across sweep/redraw cycles", () => {
  it("leaves exactly one listener bound after four sweep/redraw cycles", () => {
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    draw(harness.map);
    expect(harness.liveListeners("click", LAYER_ID)).toBe(1);

    // Four sweeps and four redraws - what four card clicks amount to. Before
    // SCRUM-722 this was five.
    for (let i = 0; i < 4; i += 1) {
      clearOtherUserMarkers(harness.map);
      draw(harness.map);
    }

    expect(harness.liveListeners("click", LAYER_ID)).toBe(1);
  });

  it("runs the handler exactly once for one click after four cycles", () => {
    const harness = buildMap();
    const handler = jest.fn();
    setPointClickHandler(harness.map, handler);

    draw(harness.map);
    for (let i = 0; i < 4; i += 1) {
      clearOtherUserMarkers(harness.map);
      draw(harness.map);
    }
    handler.mockClear();

    harness.fire("click", LAYER_ID);

    // The number measured in Chromium against real Mapbox GL: 1 after the fix,
    // 5 before it.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves no listener at all on a pin the sweep removed", () => {
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    draw(harness.map);
    clearOtherUserMarkers(harness.map);

    expect(harness.liveListeners("click", LAYER_ID)).toBe(0);
    expect(harness.layers).not.toContain(LAYER_ID);
  });

  it("unbinds the handler from `handlers.ts` itself, which is what lets `off` name it", () => {
    const harness = buildMap();
    const handler = jest.fn();
    setPointClickHandler(harness.map, handler);

    draw(harness.map);
    clearOtherUserMarkers(harness.map);

    // A wrapper closure built at sweep time would be a different function from
    // the one `updateCompanyLocation` bound, so `off` could never name it and
    // the counts above would go back to climbing.
    expect(harness.off).toHaveBeenCalledWith("click", LAYER_ID, handler);
  });
});

describe("which swept layers get an unbind", () => {
  it("unbinds the destination icon layer only, and nothing else it sweeps", () => {
    // All four layers one member's markers amount to. Only the destination
    // icon layer ever carries a listener: `updateCompanyLocation` is the sole
    // caller of `map.on("click", ...)` for a pin, and it binds to `layerId`
    // alone. A spurious `off` on the other three would be a no-op today and
    // would mask a real leak on one of them later.
    const harness = buildMap([
      LAYER_ID,
      TEXT_LAYER_ID,
      START_LAYER_ID,
      START_TEXT_LAYER_ID,
    ]);
    const handler = jest.fn();
    setPointClickHandler(harness.map, handler);

    clearOtherUserMarkers(harness.map);

    expect(harness.off.mock.calls).toEqual([["click", LAYER_ID, handler]]);
  });

  it("unbinds nothing when no handler is registered for the map", () => {
    // `addMapEvents` registers the handler inside the map's `load`, before any
    // of this runs, so an unregistered map is a guard rather than a case - the
    // same guard the bind path uses. It is what keeps the fake maps in
    // `clearOtherUserMarkers.test.ts`, which model no listener table at all,
    // working untouched.
    const harness = buildMap([LAYER_ID, TEXT_LAYER_ID]);

    clearOtherUserMarkers(harness.map);

    expect(harness.off).not.toHaveBeenCalled();
    expect(harness.layers).toEqual([]);
  });

  it("still removes every layer, source and image the sweep is responsible for", () => {
    // The unbind is inserted into the removal loop, so it must not shorten it.
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    draw(harness.map);
    clearOtherUserMarkers(harness.map);

    expect(harness.layers).toEqual([]);
  });

  it("removes the layer anyway when the unbind throws", () => {
    // The unbind is best-effort cleanup of a listener on a layer that is going
    // away regardless. If it shared the removal's `try`, a throwing `off`
    // would skip the `removeLayer` after it and strand a visible pin - the
    // failure this file's per-layer guards exist to prevent.
    const harness = buildMap([LAYER_ID, TEXT_LAYER_ID]);
    setPointClickHandler(harness.map, jest.fn());
    harness.off.mockImplementationOnce((_e, layerId) => {
      throw new Error(`cannot unbind ${layerId}`);
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => clearOtherUserMarkers(harness.map)).not.toThrow();

    expect(harness.layers).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
