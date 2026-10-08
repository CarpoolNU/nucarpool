/**
 * `addMapEvents` binds the point-click handler only to the `riders` and
 * `drivers` layers, never as a generic unscoped `click` listener.
 *
 * Mapbox populates `event.features` only for a listener registered against a
 * layer - its own documentation says so, and `createPointClickHandler` opens
 * with `if (!e.features) return`. A generic listener would instead run
 * `getStyle().layers.filter(...)` and a `queryRenderedFeatures` across every
 * symbol layer on every click anywhere on the map, then hand the result to a
 * handler that returns immediately - work with no effect.
 *
 * These tests pin down both directions, because the two layer-scoped bindings
 * are the only ones that do anything: removing them silently stops every pin
 * from opening its popup, with no error to show for it.
 */

import type { Map } from "mapbox-gl";
import addMapEvents from "./addMapEvents";
import { getPointClickHandler } from "./handlers";

jest.mock("mapbox-gl", () => ({
  __esModule: true,
  NavigationControl: class NavigationControl {},
}));

type Binding = { event: string; layer?: string; handler: (e: never) => void };

const fakeMap = () => {
  const bindings: Binding[] = [];
  return {
    bindings,
    addControl: jest.fn(),
    getCanvas: () => ({ style: {} }),
    getStyle: () => ({
      layers: [
        { id: "riders", type: "symbol" },
        { id: "drivers", type: "symbol" },
        { id: "clusters", type: "circle" },
      ],
    }),
    queryRenderedFeatures: jest.fn(() => [{ properties: { id: "rider-1" } }]),
    on: jest.fn((event: string, second: unknown, third?: unknown) => {
      if (typeof second === "string") {
        bindings.push({
          event,
          layer: second,
          handler: third as (e: never) => void,
        });
      } else {
        bindings.push({ event, handler: second as (e: never) => void });
      }
    }),
  };
};

/** What Mapbox hands a listener that was registered against a layer. */
const layerTap = (map: ReturnType<typeof fakeMap>) =>
  ({
    features: [{ properties: { id: "rider-1" } }],
    point: { x: 1, y: 2 },
    target: map,
  }) as never;

describe("addMapEvents", () => {
  it("still answers a tap on a rider or driver pin", () => {
    const map = fakeMap();

    addMapEvents(map as unknown as Map, jest.fn());

    const layers = map.bindings
      .filter((binding) => binding.event === "click" && binding.layer)
      .map((binding) => binding.layer);

    expect(layers).toEqual(expect.arrayContaining(["riders", "drivers"]));
  });

  /**
   * A click that hits no layer must trigger no point-click work at all - not
   * even a render query whose result gets discarded.
   */
  it("does no point-click work on a click that hit no layer", () => {
    const map = fakeMap();

    addMapEvents(map as unknown as Map, jest.fn());

    const unscoped = map.bindings.filter(
      (binding) => binding.event === "click" && !binding.layer,
    );

    expect(unscoped).toEqual([]);
  });

  it("reports a tapped pin to the page once, not twice", () => {
    const setPopupUser = jest.fn();
    const map = fakeMap();

    addMapEvents(map as unknown as Map, setPopupUser);

    // Exactly what a real tap on a rider pin triggers: every click binding
    // whose layer that pin belongs to, and nothing else.
    map.bindings
      .filter((binding) => binding.event === "click" && binding.layer)
      .filter((binding) => binding.layer === "riders")
      .forEach((binding) => binding.handler(layerTap(map)));

    expect(setPopupUser).toHaveBeenCalledTimes(1);
    expect(setPopupUser).toHaveBeenCalledWith([{ id: "rider-1" }]);
  });

  it("registers its point-click handler against the map it was given", () => {
    const map = fakeMap() as unknown as Map;

    addMapEvents(map, jest.fn());

    expect(getPointClickHandler(map)).toEqual(expect.any(Function));
  });
});
