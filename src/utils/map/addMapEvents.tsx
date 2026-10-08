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

  // `handlePointClick` is bound only to these two layers, never as a generic
  // unscoped `click` listener. Mapbox populates `event.features` only for a
  // listener registered against a layer ("If no `layerId` was specified when
  // adding the event listener, `features` will be `undefined`"), and
  // `createPointClickHandler` opens with `if (!e.features) return` - so an
  // unscoped listener would pay for a full render query on every click
  // anywhere on the map, including the empty ocean, and throw the result away
  // without ever opening a popup.
  //
  // These two bindings are the only path that opens a popup. Removing them -
  // even though a generic listener looks like an equivalent catch-all - stops
  // every pin answering a tap, with no error to show for it.
  map.on("click", "riders", handlePointClick);
  map.on("click", "drivers", handlePointClick);

  map.on("mouseenter", "clusters", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "clusters", () => {
    map.getCanvas().style.cursor = "";
  });

  // The recentre control is wired through the button's own onClick, not here.
  // Keeping it inside React's lifecycle means it is bound once the button
  // mounts rather than depending on `document.getElementById` finding it
  // already in the DOM, and it is cleaned up when the button unmounts.
};

export default addMapEvents;
