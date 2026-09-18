import mapboxgl from "mapbox-gl";
import { debounce } from "lodash";
import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The explore map's lifecycle, lifted out of `src/pages/index.tsx`.
 *
 * The effect this replaces built its `mapboxgl.Map` and returned nothing, so
 * every unmount left the GL context, the tiles, the six `map.on` listeners and
 * a `NavigationControl` alive and referenced. `index.tsx` has no test - its own
 * comments cite that as the reason decisions keep getting lifted out of it -
 * which is why the lifecycle lives here, beside `useMapInstance.test.tsx`,
 * rather than being fixed in place.
 *
 * The leak was only reachable on mobile: the Profile tab is a `router.push`,
 * so browser Back remounts the explore page client-side, and each round trip
 * built another map. iOS Safari caps live WebGL contexts at roughly 8-16 and
 * silently drops the oldest, which is the blank map users were reporting.
 */

/** Matches the delay the page's hand-rolled `setTimeout` already used. */
export const MAP_RESIZE_DEBOUNCE_MS = 100;

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
  style = "mapbox://styles/mapbox/light-v10",
  onLoad,
}: MapInstanceOptions): MapInstance {
  const [map, setMap] = useState<mapboxgl.Map>();
  const [isLoaded, setIsLoaded] = useState(false);

  /**
   * Construction values and the load callback are read once, when the map is
   * built, so they are held in a ref instead of in the dependency list below.
   *
   * This is the load-bearing half of the fix, not a tidy-up. The effect this
   * replaces depended on `[mapContainerRef, user]` and was held to one map by
   * a `useRef` flag; hanging a `remove()` cleanup off it unchanged would
   * destroy and rebuild the map on every `user.me` refetch, because react-query
   * returns a new object each time - taking the viewport, the drawn route and
   * every marker with it. The flag is gone because the dependencies are now
   * honest: this effect really does run once per mount.
   */
  const latest = useRef({ center, zoom, maxZoom, style, onLoad });
  latest.current = { center, zoom, maxZoom, style, onLoad };

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
 * Every `resize` event used to queue its own `setTimeout(map.resize, 100)`,
 * with no `clearTimeout` - so N events meant N full WebGL canvas resizes and
 * tile repaints. That is a rounding error when a desktop user drags a window,
 * and dozens of times in a few seconds on iOS Safari, which fires `resize` on
 * every URL-bar collapse and expand during an ordinary scroll.
 *
 * **A `ResizeObserver` on the container itself (SCRUM-518), not a `window`
 * `resize` listener plus a `layoutKey` the caller had to remember to pass.**
 * `mapbox-gl` 3.30 has no internal `ResizeObserver` - it never watches its own
 * container - so this hook was inferring the container's box from the
 * `window`'s instead, which is only a proxy for it. A `layoutKey` (the page
 * passed `isMobile`) papered over the gap for the one layout change the page
 * knew about, but any other container resize with no matching `window` event
 * - the container settling into its final box after mount, or the row's
 * height changing for a reason that never reaches `window` - left the canvas
 * at its previous size until the next `window` `resize` happened to arrive.
 * A `ResizeObserver` on the container removes the inference entirely: it
 * fires on the box `mapbox-gl` actually cares about, for any reason that box
 * changes, so there is no second parameter for a caller to remember.
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
