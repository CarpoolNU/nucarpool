import { GeoJSONSource, Map, NavigationControl } from "mapbox-gl";
import { PublicUser } from "../types";
import { Dispatch, SetStateAction } from "react";
import { setPointClickHandler, createPointClickHandler } from "./handlers";

const addMapEvents = (
  map: Map,
  setPopupUser: Dispatch<SetStateAction<PublicUser[] | null>>,
) => {
  map.addControl(new NavigationControl(), "bottom-right");

  const handlePointClick = createPointClickHandler(setPopupUser);
  setPointClickHandler(map, handlePointClick);

  map.on("click", "clusters", (e) => {
    const features = map.queryRenderedFeatures(e.point, {
      layers: ["clusters"],
    });
    const clusterId = features[0]!.properties!.cluster_id;
    const source = map.getSource("company-locations") as GeoJSONSource;
    source.getClusterExpansionZoom(clusterId, (err, zoom) => {
      // mapbox-gl v3 types this callback as Callback<number>, so `zoom` is
      // `number | null | undefined` - easeTo takes `number | undefined`, and a
      // cluster with no expansion zoom is nothing to ease to.
      if (err || zoom == null) return;
      if (features[0]!.geometry.type === "Point") {
        map.easeTo({
          center: [
            features[0]!.geometry.coordinates[0]!,
            features[0]!.geometry.coordinates[1]!,
          ],
          zoom: zoom,
        });
      }
    });
  });

  // A third binding of `handlePointClick` stood here: a generic `click`
  // listener that filtered every symbol layer out of the style and ran
  // `queryRenderedFeatures` across all of them, on every click anywhere on the
  // map - the empty ocean included.
  //
  // It never once opened a popup. Mapbox populates `event.features` only for a
  // listener registered against a layer ("If no `layerId` was specified when
  // adding the event listener, `features` will be `undefined`"), and
  // `createPointClickHandler` opens with `if (!e.features) return`. So every
  // click paid for a full render query whose result was thrown away, and the
  // two layer-scoped bindings below were always the path that did the work.
  //
  // Which is why they stay. Deleting them instead - the symmetric-looking
  // change - stops every pin answering a tap, with no error to show for it.
  map.on("click", "riders", handlePointClick);
  map.on("click", "drivers", handlePointClick);

  map.on("mouseenter", "clusters", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "clusters", () => {
    map.getCanvas().style.cursor = "";
  });

  // The recentre control used to be wired here with
  // `document.getElementById("fly").addEventListener(...)`. That reached outside
  // React's lifecycle: the listener was never removed, and it bound only if the
  // button happened to already be in the DOM when the map finished loading. The
  // button now owns its own onClick.
};

export default addMapEvents;
