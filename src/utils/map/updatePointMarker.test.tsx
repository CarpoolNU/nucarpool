/**
 * The contract `updateStartLocation` and `updateCompanyLocation` share, now
 * that one builder draws both (SCRUM-718).
 *
 * **These assertions exist because the ids are a cross-module interface.**
 * `clearOtherUserMarkers` finds a pin to tear down by matching its layer id
 * against a regex, so a renamed id does not fail - it stops matching, the pin
 * survives every sweep, and nothing says so. The literal strings below are the
 * only automated check that the merge kept them byte-identical.
 *
 * What this cannot reach is everything Mapbox actually does with them. jsdom
 * has no WebGL and Mapbox GL does not run here, so the fake map below records
 * calls and nothing renders. **A green run here is not evidence that a marker
 * appears on a real map** - that needs the manual Chromium check the ticket
 * requires, and this file is a guard against silent id drift, not a substitute
 * for it.
 *
 * A `.tsx` test deliberately, despite testing no component: both modules
 * import PNGs, and only the jsdom project maps a static image import to a
 * stub. See `updateCompanyLocation.clickHandler.test.tsx`, which explains that
 * at length and owns the listener-leak assertions this file does not repeat.
 */

import updateStartLocation from "./updateStartLocation";
import updateCompanyLocation from "./updateCompanyLocation";
import { setPointClickHandler } from "./handlers";
import { Role } from "@prisma/client";

const USER_ID = "clyt9e0x40000ld19lfjt6tqy";
const LNG = -71.09;
const LAT = 42.34;

interface AddedLayer {
  id: string;
  type: string;
  source: string;
}

/**
 * A fake map that records what was added, under which id, and in front of
 * what.
 *
 * The listener table is an **array** per key, not a set, for the reason the
 * click-handler suite gives: Mapbox's `on` appends without deduplicating, so a
 * set would collapse a leak into a single entry and hide it.
 */
const buildMap = () => {
  const layers = new Set<string>();
  const sources = new Map<string, { setData: jest.Mock }>();
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const key = (event: string, layerId: string) => `${event}:${layerId}`;

  const addedLayers: { layer: AddedLayer; before?: string }[] = [];
  const addedSources: {
    id: string;
    data: GeoJSON.Feature<GeoJSON.Point>;
  }[] = [];

  const map = {
    loadImage: (_src: string, callback: (e: unknown, i: unknown) => void) =>
      callback(null, new Image()),
    hasImage: () => true,
    addImage: jest.fn(),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: jest.fn((layer: AddedLayer, before?: string) => {
      layers.add(layer.id);
      addedLayers.push({ layer, before });
    }),
    removeLayer: jest.fn((id: string) => layers.delete(id)),
    getSource: (id: string) => sources.get(id),
    addSource: jest.fn(
      (id: string, source: { data: GeoJSON.Feature<GeoJSON.Point> }) => {
        sources.set(id, { setData: jest.fn() });
        addedSources.push({ id, data: source.data });
      },
    ),
    removeSource: jest.fn((id: string) => sources.delete(id)),
    removeImage: jest.fn(),
    on: jest.fn(
      (event: string, layerId: string, handler: (...a: unknown[]) => void) => {
        const k = key(event, layerId);
        if (!listeners.has(k)) listeners.set(k, []);
        listeners.get(k)!.push(handler);
      },
    ),
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
    raw: map,
    addedLayers,
    addedSources,
    layerIds: () => addedLayers.map(({ layer }) => layer.id),
    label: (sourceId: string) =>
      addedSources.find((entry) => entry.id === sourceId)?.data.properties
        ?.label,
    liveListeners: (event: string, layerId: string) =>
      listeners.get(key(event, layerId))?.length ?? 0,
  };
};

describe("the ids each marker owns", () => {
  it("names another user's start pin `other-user-<id>-start-*`", () => {
    const harness = buildMap();

    updateStartLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
      false,
      false,
      "Rider 1 Start",
    );

    expect(harness.addedSources.map(({ id }) => id)).toEqual([
      `other-user-${USER_ID}-start-source`,
    ]);
    expect(harness.layerIds()).toEqual([
      `other-user-${USER_ID}-start-layer`,
      `other-user-${USER_ID}-start-text-layer`,
    ]);
  });

  it("names another user's destination pin `other-user-<id>-company-*`", () => {
    const harness = buildMap();

    updateCompanyLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
      false,
      false,
      "Rider 1 Dest.",
    );

    expect(harness.addedSources.map(({ id }) => id)).toEqual([
      `other-user-${USER_ID}-company-source`,
    ]);
    expect(harness.layerIds()).toEqual([
      `other-user-${USER_ID}-company-layer`,
      `other-user-${USER_ID}-company-text-layer`,
    ]);
  });

  it("names the viewer's own destination pin `current-user-company-*`, with no user id in it", () => {
    const harness = buildMap();

    updateCompanyLocation(
      harness.map,
      LNG,
      LAT,
      Role.DRIVER,
      USER_ID,
      undefined,
      true,
      false,
      "Me",
    );

    expect(harness.addedSources.map(({ id }) => id)).toEqual([
      "current-user-company-source",
    ]);
    expect(harness.layerIds()).toEqual([
      "current-user-company-layer",
      "current-user-company-text-layer",
    ]);
  });

  it("puts every layer under `waterway-label`, so base-style text stays on top", () => {
    const harness = buildMap();

    updateCompanyLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
      false,
      false,
      "Rider 1 Dest.",
    );

    expect(harness.addedLayers).toHaveLength(2);
    harness.addedLayers.forEach(({ before }) =>
      expect(before).toBe("waterway-label"),
    );
  });

  it("adds no label layer when no custom label is given", () => {
    const harness = buildMap();

    updateStartLocation(harness.map, LNG, LAT, Role.RIDER, USER_ID, undefined);

    expect(harness.layerIds()).toEqual([`other-user-${USER_ID}-start-layer`]);
  });
});

describe("the label a pin carries", () => {
  it("falls back to `Start` for a start pin with nothing else to show", () => {
    const harness = buildMap();

    updateStartLocation(harness.map, LNG, LAT, Role.RIDER, USER_ID, undefined);

    expect(harness.label(`other-user-${USER_ID}-start-source`)).toBe("Start");
  });

  it("falls back to `Destination` for a destination pin", () => {
    const harness = buildMap();

    updateCompanyLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
    );

    expect(harness.label(`other-user-${USER_ID}-company-source`)).toBe(
      "Destination",
    );
  });

  it("prefers the custom label over the fallback", () => {
    const harness = buildMap();

    updateStartLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
      false,
      false,
      "Rider 1 Start",
    );

    expect(harness.label(`other-user-${USER_ID}-start-source`)).toBe(
      "Rider 1 Start",
    );
  });
});

describe("what the viewer's own start position does", () => {
  /**
   * `updateUserLocation` already puts a pulsing dot exactly there, so a start
   * marker for the viewer would sit on top of it. The early return is the
   * behaviour, not an oversight - these two tests are what stops the merged
   * builder quietly starting to draw one.
   */
  it("draws nothing at all", () => {
    const harness = buildMap();

    updateStartLocation(
      harness.map,
      LNG,
      LAT,
      Role.DRIVER,
      USER_ID,
      undefined,
      true,
    );

    expect(harness.raw.addSource).not.toHaveBeenCalled();
    expect(harness.raw.addLayer).not.toHaveBeenCalled();
    expect(harness.raw.addImage).not.toHaveBeenCalled();
  });

  it("removes nothing either, because it never drew anything to remove", () => {
    const harness = buildMap();

    updateStartLocation(
      harness.map,
      LNG,
      LAT,
      Role.DRIVER,
      USER_ID,
      undefined,
      true,
      true,
    );

    expect(harness.raw.removeLayer).not.toHaveBeenCalled();
    expect(harness.raw.removeSource).not.toHaveBeenCalled();
    expect(harness.raw.removeImage).not.toHaveBeenCalled();
  });
});

describe("which pins are clickable", () => {
  it("binds no click listener to a start pin, whose popup comes from the destination pin", () => {
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    updateStartLocation(harness.map, LNG, LAT, Role.RIDER, USER_ID, undefined);

    // The positive control: the same harness and the same registered handler
    // do bind for a destination pin, so this assertion is about the start
    // pin's spec rather than about the handler never having been available.
    expect(
      harness.liveListeners("click", `other-user-${USER_ID}-start-layer`),
    ).toBe(0);

    updateCompanyLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
    );

    expect(
      harness.liveListeners("click", `other-user-${USER_ID}-company-layer`),
    ).toBe(1);
  });

  it("calls `off` for no start layer on removal, there being nothing bound to unbind", () => {
    const harness = buildMap();
    setPointClickHandler(harness.map, jest.fn());

    updateStartLocation(harness.map, LNG, LAT, Role.RIDER, USER_ID, undefined);
    updateStartLocation(
      harness.map,
      LNG,
      LAT,
      Role.RIDER,
      USER_ID,
      undefined,
      false,
      true,
    );

    expect(harness.raw.off).not.toHaveBeenCalled();
    expect(harness.raw.removeLayer).toHaveBeenCalledWith(
      `other-user-${USER_ID}-start-layer`,
    );
  });
});
