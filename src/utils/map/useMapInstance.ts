import mapboxgl from "mapbox-gl";
import { debounce } from "lodash";
import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The explore map's lifecycle.
 *
 * Every unmount must tear down the GL context, the tiles, the `map.on`
 * listeners and the `NavigationControl` - leaving any of them alive and
 * referenced matters because this is reachable on mobile: the Profile tab is
 * a `router.push`, so browser Back remounts the explore page client-side, and
 * each round trip builds another map. iOS Safari caps live WebGL contexts at
 * roughly 8-16 and silently drops the oldest, which shows up as a blank map.
 */

/** Matches the delay the page's hand-rolled `setTimeout` already used. */
export const MAP_RESIZE_DEBOUNCE_MS = 100;

/**
 * The zoom-out floor applied when a caller does not supply its own.
 *
 * **Derived from Mapbox's tile pyramid, not chosen by feel.** At zoom `z` the
 * world is rendered into a `512 * 2^z` px square: that width is the Mercator
 * projection's full longitude range, and the height is equal because the
 * projection's latitude clamp (~85.0511°, the standard Web Mercator bound) was
 * itself chosen to make the two match. Below the zoom where that square still
 * covers the container, the container is taller (or wider) than the rendered
 * world, and Mapbox has nothing to paint past the clamp - the white box below
 * the map that this ticket is about.
 *
 * So the floor has to satisfy `512 * 2^minZoom >= containerHeightPx` for every
 * container this map is ever laid out into. 3 gives a 4096px world, which
 * clears every mobile viewport by a wide margin and still covers desktop
 * windows well past any ordinary monitor - while still leaving the app free
 * to zoom out to a regional, multi-city view before the floor engages.
 */
export const DEFAULT_MIN_ZOOM = 3;

export type MapInstanceOptions = {
  /** The DOM id Mapbox renders into. */
  containerId: string;
  /**
   * The same node, as a ref. Mapbox is handed the id, so this exists only to
   * prove the container is actually mounted before the map is built.
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Where the map opens, or `null` while that is still unknown - the page does
   * not know its centre until `user.me` resolves. No map is built until this
   * is non-null, which replaces the `user &&` guard on the old effect.
   */
  center: [number, number] | null;
  zoom?: number;
  maxZoom?: number;
  /**
   * How far the map can be zoomed out, floored below by `DEFAULT_MIN_ZOOM`'s
   * derivation - see the comment there before lowering this.
   */
  minZoom?: number;
  style?: string;
  /**
   * Run once, when Mapbox reports the style and tiles loaded. Everything that
   * needs a *ready* map - event wiring, the user's own pins - belongs here.
   */
  onLoad?: (map: mapboxgl.Map) => void;
};

export type MapInstance = {
  /** Undefined until the map has loaded, so consumers cannot touch it early. */
  map: mapboxgl.Map | undefined;
  isLoaded: boolean;
};

export function useMapInstance({
  containerId,
  containerRef,
  center,
  zoom = 8,
  maxZoom = 13,
  minZoom = DEFAULT_MIN_ZOOM,
  style = "mapbox://styles/mapbox/light-v10",
  onLoad,
}: MapInstanceOptions): MapInstance {
  const [map, setMap] = useState<mapboxgl.Map>();
  const [isLoaded, setIsLoaded] = useState(false);

  /**
   * Construction values and the load callback are read once, when the map is
   * built, so they are held in a ref instead of in the dependency list below.
   *
   * This is load-bearing, not a style preference. Depending on `user` (or
   * `onLoad`, which closes over it) would destroy and rebuild the map on
   * every `user.me` refetch, because react-query hands back a new object each
   * time - taking the viewport, the drawn route and every marker with it. The
   * effect's dependencies are honest instead: it runs once per mount, with no
   * flag needed to hold it to one map.
   */
  const latest = useRef({ center, zoom, maxZoom, minZoom, style, onLoad });
  latest.current = { center, zoom, maxZoom, minZoom, style, onLoad };

  const hasCenter = center !== null;

  useEffect(() => {
    if (!hasCenter || !containerRef.current) return;

    const opening = latest.current;
    const newMap = new mapboxgl.Map({
      container: containerId,
      style: opening.style,
      center: opening.center!,
      zoom: opening.zoom,
    });

    // A `load` can land after React has torn the page down - the style and
    // first tiles are a network round trip, and a fast Back beats them.
    // Without this the callback would wire events onto a map being removed.
    let live = true;

    newMap.on("load", () => {
      if (!live) return;
      newMap.setMaxZoom(opening.maxZoom);
      newMap.setMinZoom(opening.minZoom);
      setMap(newMap);
      latest.current.onLoad?.(newMap);
      setIsLoaded(true);
    });

    return () => {
      live = false;
      setMap(undefined);
      setIsLoaded(false);
      newMap.remove();
    };
    // `containerRef` is deliberately absent: a ref object is stable, and
    // depending on its identity is how a caller that builds one inline would
    // get a rebuilt map without ever being told.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCenter, containerId]);

  return { map, isLoaded };
}

/**
 * Keeps the map's canvas matched to its container.
 *
 * `resize` events must collapse into a single debounced `map.resize()` call
 * rather than firing one per event: a full WebGL canvas resize and tile
 * repaint per event is a rounding error when a desktop user drags a window,
 * but iOS Safari fires `resize` dozens of times in a few seconds on every
 * URL-bar collapse and expand during an ordinary scroll.
 *
 * **A `ResizeObserver` on the container itself, not a `window` `resize`
 * listener.** `mapbox-gl` 3.30 has no internal `ResizeObserver` - it never
 * watches its own container - so inferring the container's box from the
 * `window`'s instead is only a proxy for it: a layout change that never
 * dispatches a `window` `resize` event - the container settling into its
 * final box after mount, or a row's height changing for a reason the window
 * never sees - would leave the canvas at its previous size until some later
 * `window` `resize` happened to arrive. A `ResizeObserver` on the container
 * removes that gap entirely: it fires on the box `mapbox-gl` actually cares
 * about, for any reason that box changes.
 */
export function useMapResize(
  map: mapboxgl.Map | undefined,
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!map) return;

    const resize = debounce(() => map.resize(), MAP_RESIZE_DEBOUNCE_MS);

    // The initial sizing, which the container needs because it is laid out
    // after the map is constructed. It goes through the same debounce, so it
    // keeps the delay the old `setTimeout` gave it and collapses into a burst
    // that arrives on top of it.
    resize();

    const container = containerRef.current;
    const observer = container && new ResizeObserver(resize);
    if (observer) {
      observer.observe(container);
    }

    return () => {
      // Cancel before removing: a pending call would otherwise fire against a
      // map this component is about to destroy.
      resize.cancel();
      observer?.disconnect();
    };
    // `containerRef` is deliberately absent, for the reason `useMapInstance`
    // gives for the same omission: a ref object is stable, so depending on its
    // identity buys nothing a caller that built one inline would notice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
}
