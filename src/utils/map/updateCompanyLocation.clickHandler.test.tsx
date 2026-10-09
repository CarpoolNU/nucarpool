/**
 * `updateCompanyLocation` must unbind its click listener before removing the
 * layer it is scoped to - removing a layer does **not** remove the listeners
 * scoped to it, so a remove/redraw cycle with no explicit `map.off` would
 * leave another live handler behind each time, and a single click would run
 * the handler once per cycle. The cycle is not hypothetical: `viewRouteClick`
 * and `groupRouteClick` sweep and redraw other users' pins on every card
 * click.
 *
 * **Live listeners are counted, not calls.** A call count cannot tell one
 * surviving listener from four, which is the whole question here; the fake map
 * below models `on`/`off` as a set so the assertion is on what is still bound.
 *
 * A `.tsx` test deliberately, despite testing no component: this module
 * imports four PNGs, and only the jsdom project maps a static image import to
 * a stub. A `.test.ts` here lands in the node project and dies at load trying
 * to parse a PNG - which `jest.config.js` says is meant to fail loudly.
 */

import updateCompanyLocation from "./updateCompanyLocation";
import { setPointClickHandler } from "./handlers";
import { Role } from "@prisma/client";

const USER_ID = "clyt9e0x40000ld19lfjt6tqy";
const LAYER_ID = `other-user-${USER_ID}-company-layer`;

/**
 * A fake map that models the listener table, the layer set and the source set.
 *
 * `loadImage` invokes its callback synchronously with an `Image`, because
 * everything this module does to the map happens inside that callback. The
 * real one is asynchronous, which does not change what gets bound.
 */
const buildMap = () => {
  const layers = new Set<string>();
  const sources = new Map<string, { setData: jest.Mock }>();
  /**
   * `"<event>:<layerId>"` to the listeners currently bound for it.
   *
   * An **array**, not a set, because that is what Mapbox keeps: `on` appends
   * unconditionally and does not deduplicate, so binding the same function
   * twice really does run it twice. A set would hide a leak: with the handler
   * stable, redundant binds would collapse to one entry and the cycle
   * assertion below would pass regardless of how many listeners are bound.
   */
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const key = (event: string, layerId: string) => `${event}:${layerId}`;

  const map = {
    loadImage: (_src: string, callback: (e: unknown, i: unknown) => void) =>
      callback(null, new Image()),
    hasImage: () => true,
    addImage: jest.fn(),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: jest.fn((layer: { id: string }) => layers.add(layer.id)),
    removeLayer: jest.fn((id: string) => layers.delete(id)),
    getSource: (id: string) => sources.get(id),
    addSource: jest.fn((id: string) => sources.set(id, { setData: jest.fn() })),
    removeSource: jest.fn((id: string) => sources.delete(id)),
    removeImage: jest.fn(),
    on: jest.fn(
      (event: string, layerId: string, handler: (...a: unknown[]) => void) => {
        const k = key(event, layerId);
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k)!.push(handler);
      },
    ),
    // Mapbox removes one matching entry, not every match.
    off: jest.fn(
      (event: string, layerId: string, handler: (...a: unknown[]) => void) => {
        const bound = listeners.get(key(event, layerId));
        if (!bound) return;
        const at = bound.indexOf(handler);
        if (at !== -1) bound.splice(at, 1);
      },
    ),
  };

  return {
    map: map as unknown as mapboxgl.Map,
    /** How many listeners are bound for one event on one layer, right now. */
    liveListeners: (event: string, layerId: string) =>
      listeners.get(key(event, layerId))?.length ?? 0,
    boundHandlers: (event: string, layerId: string) => [
      ...(listeners.get(key(event, layerId)) ?? []),
    ],
    layers,
  };
};

/** Draws another user's pin. */
const draw = (map: mapboxgl.Map) =>
  updateCompanyLocation(map, -71.09, 42.34, Role.RIDER, USER_ID, undefined);

/** Removes it, the way the sweep does. */
const remove = (map: mapboxgl.Map) =>
  updateCompanyLocation(
    map,
    -71.09,
    42.34,
    Role.RIDER,
    USER_ID,
    undefined,
    false,
    true,
  );

describe("the pin's click listener across rebuilds", () => {
  it("leaves exactly one listener bound after repeated remove/redraw cycles", () => {
    const harness = buildMap();
    const handler = jest.fn();
    setPointClickHandler(harness.map, handler);

    draw(harness.map);
    expect(harness.liveListeners("click", LAYER_ID)).toBe(1);

    // Four sweeps and four redraws - what four card clicks amount to. A
    // leaking bind would make this five live listeners, so one click would
    // fire the handler five times.
    for (let i = 0; i < 4; i += 1) {
      remove(harness.map);
      draw(harness.map);
    }

    expect(harness.liveListeners("click", LAYER_ID)).toBe(1);
  });

  it("unbinds on removal, so a removed pin has no listener at all", () => {
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    draw(harness.map);
    remove(harness.map);

    expect(harness.liveListeners("click", LAYER_ID)).toBe(0);
    expect(harness.layers.has(LAYER_ID)).toBe(false);
  });

  it("binds the handler from `handlers.ts` itself, which is what makes `off` able to name it", () => {
    const harness = buildMap();
    const handler = jest.fn();
    setPointClickHandler(harness.map, handler);

    draw(harness.map);

    // A wrapper closure built fresh at bind time would be a new function
    // every call, so `off` could never be handed the listener `on` added. If
    // this regresses to a wrapper, the count assertion above goes back to
    // failing.
    expect(harness.boundHandlers("click", LAYER_ID)).toEqual([handler]);
  });

  it("binds nothing for the viewer's own pin, which is not clickable", () => {
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    updateCompanyLocation(
      harness.map,
      -71.09,
      42.34,
      Role.RIDER,
      USER_ID,
      undefined,
      true,
    );

    expect(harness.liveListeners("click", "current-user-company-layer")).toBe(
      0,
    );
  });
});
