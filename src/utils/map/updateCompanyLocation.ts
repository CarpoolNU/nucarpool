import BlueEnd from "../../../public/user-dest.png";
import BlueDriverEnd from "../../../public/user-dest-driver.png";
import RedDriverEnd from "../../../public/driver-dest.png";
import OrangeRiderEnd from "../../../public/rider-dest.png";
import { Role } from "@prisma/client";
import { PublicUser } from "../types";
import { getPointClickHandler } from "./handlers";

/**
 * Binds the map's point-click handler to one layer.
 *
 * The handler comes from `handlers.ts` rather than being wrapped in a fresh
 * closure here, because `map.off` can only name a listener it is handed the
 * identical function for - and a wrapper built at bind time is a different
 * function every call, which is why the removal path could never unbind one.
 * The wrapper this replaces only repeated the `!e.features` check that
 * `createPointClickHandler` already does on entry.
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

const updateCompanyLocation = (
  map: mapboxgl.Map,
  companyLongitude: number,
  companyLatitude: number,
  role: Role,
  userId: string,
  userData?: PublicUser,
  isCurrent: boolean = false,
  remove: boolean = false,
  customLabel?: string,
): void => {
  let img, sourceId: string, layerId: string, textLayerId: string;

  if (isCurrent) {
    img = role === Role.DRIVER ? BlueDriverEnd.src : BlueEnd.src;
    sourceId = "current-user-company-source";
    layerId = "current-user-company-layer";
    textLayerId = "current-user-company-text-layer";
  } else {
    img = role === Role.DRIVER ? RedDriverEnd.src : OrangeRiderEnd.src;
    sourceId = `other-user-${userId}-company-source`;
    layerId = `other-user-${userId}-company-layer`;
    textLayerId = `other-user-${userId}-company-text-layer`;
  }

  if (remove) {
    if (map.getLayer(textLayerId)) {
      map.removeLayer(textLayerId);
    }
    if (map.getLayer(layerId)) {
      // Unbind before the layer goes. Removing a layer does not remove the
      // listeners scoped to it, and this function re-binds whenever it
      // rebuilds the layer - so without this every remove/recreate cycle left
      // another live handler behind and one click ran it once per cycle.
      //
      // `getPointClickHandler` returns the same function for a given map (a
      // `WeakMap`, see `handlers.ts`), which is what makes `off` able to name
      // the listener `on` added.
      const handlePointClick = getPointClickHandler(map);
      if (handlePointClick) {
        map.off("click", layerId, handlePointClick);
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
        coordinates: [companyLongitude, companyLatitude],
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
          "Destination",
      },
    };

    // Create source if it doesn't exist
    let source = map.getSource(sourceId) as mapboxgl.GeoJSONSource | undefined;
    if (source) {
      // If source exists, update its data
      source.setData(feature);

      if (!map.getLayer(layerId)) {
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

        if (!isCurrent) {
          bindPointClick(map, layerId);
        }
      }

      if (customLabel && !map.getLayer(textLayerId)) {
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
      }
    } else {
      // Create the source and layer if they don't exist
      map.addSource(sourceId, {
        type: "geojson",
        data: feature,
      });

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

      if (customLabel) {
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
      }

      if (!isCurrent) {
        // click event for request user markers
        bindPointClick(map, layerId);
      }
    }
  });
};

export default updateCompanyLocation;
