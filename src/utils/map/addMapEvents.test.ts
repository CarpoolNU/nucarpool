/**
 * `addMapEvents` bound the point-click handler twice: once to a generic
 * `click` listener that queried every symbol layer, and once each to the
 * `riders` and `drivers` layers.
 *
 * Only the second pair ever did anything. Mapbox populates `event.features`
 * only for a listener registered against a layer - its own documentation says
 * so, and `createPointClickHandler` opens with `if (!e.features) return` - so
 * the generic listener ran `getStyle().layers.filter(...)` and a
 * `queryRenderedFeatures` across every symbol layer on *every click anywhere
 * on the map*, then handed the result to a handler that returned immediately.
 *
 * So the doubled work was real but the dead half was the generic listener, not
 * the layer-scoped pair. These tests pin that down in both directions, because
 * deleting the wrong one silently stops every pin from opening its popup -
 * there is no error, the tap simply does nothing.
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
   * The listener this removes fired on every click on the map - including the
   * empty ocean - and threw the result away.
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
