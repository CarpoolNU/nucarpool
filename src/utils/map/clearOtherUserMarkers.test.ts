/**
 * The pin sweep.
 *
 * **Removing too much is the likelier failure**, and the harder one to notice:
 * a leftover pin is visible, whereas a swept-away cluster layer looks like an
 * empty map, which is also what a map with no matches looks like. So the
 * emphasis here is on what survives, and the survivor list is every layer and
 * source the app creates that is *not* another user's pin.
 */

import clearOtherUserMarkers from "./clearOtherUserMarkers";

const A = "clyt9e0x40000ld19lfjt6tqy";
const B = "clvs819ux0002mj198yrmnxo8";

/** Every layer the app puts on the map that must survive a sweep. */
const PROTECTED_LAYERS = [
  // The discovery map, over the `company-locations` source.
  "clusters",
  "cluster-count",
  "riders",
  "drivers",
  // The viewer's own position and destination.
  "layer-with-pulsing-dot",
  "current-user-company-layer",
  "current-user-company-text-layer",
  // The route line, whose lifecycle is `clearDirections`.
  "route",
  // A Mapbox base-style layer, which `updateCompanyLocation` inserts before.
  "waterway-label",
];

const PROTECTED_SOURCES = ["company-locations", "dot-point", "route"];

/**
 * A fake map that actually models add/remove, rather than only recording calls.
 *
 * The subject is which ids are gone afterwards, so asserting on the resulting
 * state reads better than asserting on a call list - and it catches a sweep
 * that removes a layer twice or removes one it never found.
 */
const buildMap = ({
  layers = [] as string[],
  sources = [] as string[],
  images = [] as string[],
} = {}) => {
  const layerSet = new Set(layers);
  const sourceSet = new Set(sources);
  const imageSet = new Set(images);

  const map = {
    getStyle: () => ({
      layers: [...layerSet].map((id) => ({ id })),
      sources: Object.fromEntries([...sourceSet].map((id) => [id, {}])),
    }),
    getLayer: (id: string) => (layerSet.has(id) ? { id } : undefined),
    removeLayer: jest.fn((id: string) => layerSet.delete(id)),
    getSource: (id: string) => (sourceSet.has(id) ? { id } : undefined),
    removeSource: jest.fn((id: string) => sourceSet.delete(id)),
    hasImage: (id: string) => imageSet.has(id),
    removeImage: jest.fn((id: string) => imageSet.delete(id)),
  };

  return {
    map: map as unknown as mapboxgl.Map,
    layers: layerSet,
    sources: sourceSet,
    images: imageSet,
    removeLayer: map.removeLayer,
    removeSource: map.removeSource,
  };
};

/** The four layers one group member's markers amount to. */
const pinLayers = (userId: string) => [
  `other-user-${userId}-company-layer`,
  `other-user-${userId}-company-text-layer`,
  `other-user-${userId}-start-layer`,
  `other-user-${userId}-start-text-layer`,
];

const pinSources = (userId: string) => [
  `other-user-${userId}-company-source`,
  `other-user-${userId}-start-source`,
];

describe("clearOtherUserMarkers", () => {
  describe("what it removes", () => {
    it("takes off all four layers of one member's markers", () => {
      const { map, layers } = buildMap({ layers: pinLayers(A) });

      clearOtherUserMarkers(map);

      expect([...layers]).toEqual([]);
    });

    it("takes the icon and its label together", () => {
      // The specific asymmetry SCRUM-391 exists to remove: `clearMarkers` swept
      // `-text-layer` and left the icon, so a pin lost its name and stayed.
      const { map, layers } = buildMap({
        layers: [
          `other-user-${A}-company-layer`,
          `other-user-${A}-company-text-layer`,
        ],
      });

      clearOtherUserMarkers(map);

      expect([...layers]).toEqual([]);
    });

    it("takes every member of a group, not just the first", () => {
      const { map, layers } = buildMap({
        layers: [...pinLayers(A), ...pinLayers(B)],
      });

      clearOtherUserMarkers(map);

      expect([...layers]).toEqual([]);
    });

    it("removes each pin's source and image", () => {
      const { map, sources, images } = buildMap({
        layers: pinLayers(A),
        sources: pinSources(A),
        images: pinSources(A).map((id) => `${id}-image`),
      });

      clearOtherUserMarkers(map);

      expect([...sources]).toEqual([]);
      expect([...images]).toEqual([]);
    });

    it("removes one source per pin, not one per layer", () => {
      // The icon layer and the label layer share a source, so a sweep that did
      // not dedupe would call `removeSource` twice and the second call would
      // throw on a real map.
      const { map, removeSource } = buildMap({
        layers: pinLayers(A),
        sources: pinSources(A),
      });

      clearOtherUserMarkers(map);

      expect(removeSource).toHaveBeenCalledTimes(2);
    });

    it("removes a source whose layers never appeared", () => {
      // `updateCompanyLocation` adds the source and the layer from inside an
      // async `loadImage` callback, so a sweep can land between them. A
      // stranded source then blocks the next `addSource` under that id.
      const { map, sources } = buildMap({
        sources: [`other-user-${A}-company-source`],
      });

      clearOtherUserMarkers(map);

      expect([...sources]).toEqual([]);
    });
  });

  describe("what it must not remove", () => {
    it("leaves every layer the app owns", () => {
      const { map, layers } = buildMap({ layers: PROTECTED_LAYERS });

      clearOtherUserMarkers(map);

      expect([...layers].sort()).toEqual([...PROTECTED_LAYERS].sort());
    });

    it("leaves every source the app owns", () => {
      const { map, sources } = buildMap({ sources: PROTECTED_SOURCES });

      clearOtherUserMarkers(map);

      expect([...sources].sort()).toEqual([...PROTECTED_SOURCES].sort());
    });

    it("spares the viewer's own pin while taking everyone else's", () => {
      // `current-user-company-layer` is the same shape of layer created by the
      // same function, distinguished only by the prefix. This is the pair the
      // prefix has to separate.
      const { map, layers } = buildMap({
        layers: [
          "current-user-company-layer",
          "current-user-company-text-layer",
          ...pinLayers(A),
        ],
      });

      clearOtherUserMarkers(map);

      expect([...layers].sort()).toEqual([
        "current-user-company-layer",
        "current-user-company-text-layer",
      ]);
    });

    it("removes nothing at all from a map holding only protected layers", () => {
      const { map, removeLayer, removeSource } = buildMap({
        layers: PROTECTED_LAYERS,
        sources: PROTECTED_SOURCES,
      });

      clearOtherUserMarkers(map);

      expect(removeLayer).not.toHaveBeenCalled();
      expect(removeSource).not.toHaveBeenCalled();
    });

    it("ignores a layer that merely mentions a user without being a pin", () => {
      const { map, layers } = buildMap({
        layers: [`other-user-${A}-company`, `other-user-${A}`, "other-user-"],
      });

      clearOtherUserMarkers(map);

      expect([...layers]).toHaveLength(3);
    });
  });

  describe("robustness", () => {
    it("survives a style that is not there yet", () => {
      const map = { getStyle: () => undefined } as unknown as mapboxgl.Map;

      expect(() => clearOtherUserMarkers(map)).not.toThrow();
    });

    it("survives a style with neither layers nor sources", () => {
      const map = { getStyle: () => ({}) } as unknown as mapboxgl.Map;

      expect(() => clearOtherUserMarkers(map)).not.toThrow();
    });

    it("keeps sweeping after one layer fails to come off", () => {
      // `getStyle()` is a snapshot; a layer can go between the read and the
      // removal. One failure must not abandon the rest of the sweep, or the
      // pins after it in the list stay for the session.
      const { map, layers, removeLayer } = buildMap({
        layers: [...pinLayers(A), ...pinLayers(B)],
      });
      const failing = `other-user-${A}-company-layer`;
      removeLayer.mockImplementationOnce((id: string) => {
        throw new Error(`cannot remove ${id}`);
      });
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      clearOtherUserMarkers(map);

      expect([...layers]).toEqual([failing]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  it("is idempotent", () => {
    const { map, layers, sources } = buildMap({
      layers: pinLayers(A),
      sources: pinSources(A),
    });

    clearOtherUserMarkers(map);
    expect(() => clearOtherUserMarkers(map)).not.toThrow();

    expect([...layers]).toEqual([]);
    expect([...sources]).toEqual([]);
  });
});
