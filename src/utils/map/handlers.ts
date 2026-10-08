import { Map, MapLayerMouseEvent } from "mapbox-gl";
import { PublicUser } from "../types";
import { Dispatch, SetStateAction } from "react";

/**
 * The point-click handler, keyed to the map it belongs to.
 *
 * A single module-scope variable would make every map overwrite it: once a
 * map is torn down and rebuilt across a client-side navigation, a second
 * map's handler would replace the first's globally while the first map's
 * listeners still held the old closure. It would also never clear on its
 * own, so a handler bound to an unmounted page's `setPopupUser` would outlive
 * that page.
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
