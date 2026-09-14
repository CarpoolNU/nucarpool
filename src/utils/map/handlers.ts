import { Map, MapLayerMouseEvent } from "mapbox-gl";
import { PublicUser } from "../types";
import { Dispatch, SetStateAction } from "react";

/**
 * The point-click handler, keyed to the map it belongs to.
 *
 * This was a single module-scope variable, which was invisible while the page
 * built one map and never destroyed it. The map is now torn down and rebuilt
 * across a client-side navigation, and that made the singleton wrong twice
 * over: the second map's handler replaced the first's globally while the first
 * map's listeners still held the old closure, and nothing ever cleared it, so
 * a handler bound to an unmounted page's `setPopupUser` outlived that page.
 *
 * A `WeakMap` rather than a `Map`: the entry must not be what keeps a removed
 * map alive. There is no `delete` to forget, because there is no strong
 * reference to leak - once `map.remove()` runs and the page drops its
 * reference, the handler goes with it.
 */
const pointClickHandlers = new WeakMap<Map, (e: MapLayerMouseEvent) => void>();

export const setPointClickHandler = (
  map: Map,
  handler: (e: MapLayerMouseEvent) => void,
) => {
  pointClickHandlers.set(map, handler);
};

export const getPointClickHandler = (map: Map) => {
  return pointClickHandlers.get(map) ?? null;
};

export const createPointClickHandler = (
  setPopupUser: Dispatch<SetStateAction<PublicUser[] | null>>,
) => {
  return (e: MapLayerMouseEvent) => {
    if (!e.features) return;
    const allPointLayers = e.target
      .getStyle()
      .layers.filter((layer) => layer.type === "symbol")
      .map((layer) => layer.id);
    const pointFeatures = e.target.queryRenderedFeatures(e.point, {
      layers: allPointLayers,
    });

    if (pointFeatures.length === 0) return;

    const users = pointFeatures.map(
      (feature) => feature.properties as PublicUser,
    );

    setPopupUser(users);
  };
};
