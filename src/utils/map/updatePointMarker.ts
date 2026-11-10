import { Role } from "@prisma/client";
import { PublicUser } from "../types";
import { getPointClickHandler } from "./handlers";

/**
 * One kind of single-point marker on the discovery map: an icon layer, an
 * optional label layer above it, and the source both read from.
 *
 * `updateStartLocation` and `updateCompanyLocation` were the same hundred and
 * thirty lines written twice, and only one of the two carried the listener
 * unbind that stops a remove/redraw cycle leaking a click handler. This holds
 * that body once; the two modules are the spec plus a thin wrapper.
 *
 * **The images are imported by the wrappers, not here.** Nothing in this file
 * reaches a PNG, so a `*.test.ts` against it lands in the node project and
 * runs - where a static image import would die at load. The wrappers each
 * import their own, which is also why they stay separate modules.
 */

/** The two images one marker chooses between, by the user's role. */
export interface MarkerImages {
  driver: string;
  rider: string;
}

export interface PointMarkerSpec {
  /**
   * The segment every id this marker owns is named after - `start` or
   * `company`, giving `other-user-${userId}-start-layer` and the rest.
   *
   * `clearOtherUserMarkers` matches those ids with a regex naming both
   * segments literally, and removes a layer it recognises without the caller
   * knowing. A segment changed here is therefore not a rename but a silent
   * teardown failure: the sweep stops matching, the pin survives, and nothing
   * reports it. Changing one means changing that regex in the same commit.
   */
  idSegment: "start" | "company";

  /** Drawn for anyone the viewer is looking at. */
  otherUserImages: MarkerImages;

  /**
   * Drawn for the viewer themselves, in the blue that marks a pin as *you*.
   *
   * Omitted where the viewer gets no marker of this kind at all, which is
   * `updateStartLocation`'s case: `updateUserLocation` already puts a pulsing
   * dot on that exact position, so a second marker there would sit on top of
   * it. The absence of images *is* the switch rather than a flag beside it -
   * there is nothing to draw with, so there is nothing to draw.
   */
  currentUserImages?: MarkerImages;

  /** Label shown when neither a custom label nor a name is available. */
  labelFallback: string;

  /**
   * Whether another user's icon layer gets the map's point-click handler,
   * which opens their popup. The viewer's own pin never does.
   */
  clickable: boolean;
}

/**
 * Binds the map's point-click handler to one layer.
 *
 * The handler comes from `handlers.ts` rather than being wrapped in a fresh
 * closure here, because `map.off` can only name a listener it is handed the
 * identical function for - a wrapper built at bind time would be a different
 * function every call, and the removal path could never unbind one.
 *
 * A missing handler binds nothing. `addMapEvents` registers it inside the
 * map's `load`, before anything here runs, so this is a guard rather than a
 * case - and binding a listener that would throw on the first click is not an
 * improvement on binding none.
 */
const bindPointClick = (map: mapboxgl.Map, layerId: string): void => {
  const handlePointClick = getPointClickHandler(map);
  if (handlePointClick) {
    map.on("click", layerId, handlePointClick);
  }
};

/** The icon layer, under `waterway-label` so the base style's text stays on top. */
const addIconLayer = (
  map: mapboxgl.Map,
  layerId: string,
  sourceId: string,
  imageId: string,
): void => {
  map.addLayer(
    {
      id: layerId,
      type: "symbol",
      source: sourceId,
      layout: {
        "icon-image": imageId,
        "icon-allow-overlap": true,
        "icon-size": 0.33,
      },
    },
    "waterway-label",
  );
};

/** The label layer, reading the `label` property the feature below carries. */
const addLabelLayer = (
  map: mapboxgl.Map,
  textLayerId: string,
  sourceId: string,
): void => {
  map.addLayer(
    {
      id: textLayerId,
      type: "symbol",
      source: sourceId,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": 14,
        "text-offset": [0, 1.8],
        "text-anchor": "top",
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: {
        "text-color": "#000000",
        "text-halo-color": "#ffffff",
        "text-halo-width": 2.5,
        "text-halo-blur": 0.5,
      },
      minzoom: 0,
    },
    "waterway-label",
  );
};

/**
 * Draws, updates or removes one point marker.
 *
 * The parameters after `spec` are `updateStartLocation`'s and
 * `updateCompanyLocation`'s own, in their order, so the wrappers forward and
 * nothing else.
 */
const updatePointMarker = (
  spec: PointMarkerSpec,
  map: mapboxgl.Map,
  longitude: number,
  latitude: number,
  role: Role,
  userId: string,
  userData?: PublicUser,
  isCurrent: boolean = false,
  remove: boolean = false,
  customLabel?: string,
): void => {
  let img: string;
  let sourceId: string;
  let layerId: string;
  let textLayerId: string;

  if (isCurrent) {
    if (!spec.currentUserImages) {
      // For current user, we use the pulsing dot from updateUserLocation
      return; // Don't create a separate marker for current user start
    }
    img =
      role === Role.DRIVER
        ? spec.currentUserImages.driver
        : spec.currentUserImages.rider;
    sourceId = `current-user-${spec.idSegment}-source`;
    layerId = `current-user-${spec.idSegment}-layer`;
    textLayerId = `current-user-${spec.idSegment}-text-layer`;
  } else {
    img =
      role === Role.DRIVER
        ? spec.otherUserImages.driver
        : spec.otherUserImages.rider;
    sourceId = `other-user-${userId}-${spec.idSegment}-source`;
    layerId = `other-user-${userId}-${spec.idSegment}-layer`;
    textLayerId = `other-user-${userId}-${spec.idSegment}-text-layer`;
  }

  if (remove) {
    if (map.getLayer(textLayerId)) {
      map.removeLayer(textLayerId);
    }
    if (map.getLayer(layerId)) {
      // Unbind before the layer goes. Removing a layer does not remove the
      // listeners scoped to it, and this function re-binds whenever it
      // rebuilds the layer - so without this, every remove/recreate cycle
      // would leave another live handler behind and one click would run it
      // once per cycle.
      //
      // `getPointClickHandler` returns the same function for a given map (a
      // `WeakMap`, see `handlers.ts`), which is what makes `off` able to name
      // the listener `on` added.
      if (spec.clickable) {
        const handlePointClick = getPointClickHandler(map);
        if (handlePointClick) {
          map.off("click", layerId, handlePointClick);
        }
      }
      map.removeLayer(layerId);
    }
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
    if (map.hasImage(`${sourceId}-image`)) {
      map.removeImage(`${sourceId}-image`);
    }
    return;
  }

  map.loadImage(img, (error, image) => {
    if (error) throw error;

    const imageId = `${sourceId}-image`;
    if (!map.hasImage(imageId)) {
      if (image instanceof HTMLImageElement || image instanceof ImageBitmap) {
        map.addImage(imageId, image);
      }
    }

    const feature: GeoJSON.Feature<GeoJSON.Point> = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      properties: {
        ...(userData || {
          id: userId,
          role: role,
        }),
        label:
          customLabel ||
          userData?.preferredName ||
          userData?.name ||
          spec.labelFallback,
      },
    };

    // Create source if it doesn't exist
    const source = map.getSource(sourceId) as
      mapboxgl.GeoJSONSource | undefined;
    if (source) {
      // If source exists, update its data
      source.setData(feature);

      if (!map.getLayer(layerId)) {
        addIconLayer(map, layerId, sourceId, imageId);

        if (spec.clickable && !isCurrent) {
          bindPointClick(map, layerId);
        }
      }

      if (customLabel && !map.getLayer(textLayerId)) {
        addLabelLayer(map, textLayerId, sourceId);
      }
    } else {
      // Create the source and layer if they don't exist
      map.addSource(sourceId, {
        type: "geojson",
        data: feature,
      });

      addIconLayer(map, layerId, sourceId, imageId);

      if (customLabel) {
        addLabelLayer(map, textLayerId, sourceId);
      }

      if (spec.clickable && !isCurrent) {
        // click event for request user markers
        bindPointClick(map, layerId);
      }
    }
  });
};

export default updatePointMarker;
