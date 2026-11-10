import { getPointClickHandler } from "./handlers";

/**
 * Takes every *other* user's pin off the map — icon, label, source and image.
 *
 * **Asks the map which layers exist rather than remembering which were added.**
 * Identity-keyed cleanup would require every caller to track whose pin is
 * whose; `onViewGroupRoute` adds one pin per group member, and a caller that
 * forgets even one leaves it to survive a route drawn over the top, a tab
 * change and every later preview. A sweep cannot forget a pin, so a
 * bookkeeping slip here is invisible until somebody looks at the map.
 *
 * **A sweep is safe because of where it is called** — at the *start* of each
 * handler, before that handler draws its own pins. `onViewGroupRoute` sweeps
 * and then immediately re-adds every member, so its pins are never the ones
 * erased. Calling this anywhere else needs that ordering re-established first.
 *
 * **It also unbinds the click listener on the destination pin it removes.**
 * `updateCompanyLocation`'s `remove` branch does the same, but nothing calls
 * that branch for another user's pin — this sweep is the teardown path
 * production takes, and a layer removal does not remove the listeners scoped
 * to it. `unbindPointClick` below carries the detail; SCRUM-722 is why.
 *
 * ## What it deliberately does not touch
 *
 * Only the `other-user-` prefix. Removing too much is the likelier failure and
 * the harder one to notice, so these stay and `clearOtherUserMarkers.test.ts`
 * holds them there:
 *
 * - `clusters`, `cluster-count`, `riders`, `drivers` and their
 *   `company-locations` source — the discovery map itself.
 * - `layer-with-pulsing-dot` / `dot-point` — the viewer's own position.
 * - `current-user-company-layer` — the viewer's own destination.
 * - `route` — the line being drawn; its lifecycle is `clearDirections`.
 * - every Mapbox base-style layer.
 */

/**
 * Matches a pin layer and captures the stem its source is named after.
 *
 * The icon layer and the label layer of one pin share a single source, so both
 * `other-user-x-company-layer` and `other-user-x-company-text-layer` capture
 * `other-user-x-company`, and the `Set` below collapses them into one removal.
 *
 * A regex rather than `id.replace("-layer", "-source")`: a naive replace on a
 * text layer id produces `...-start-text-source`, a source that never exists,
 * because the icon and label layers share one source named after the stem
 * alone.
 */
const PIN_LAYER = /^(other-user-.+-(?:company|start))-(?:text-)?layer$/;

/** Matches a pin source directly, for one that outlived its layers. */
const PIN_SOURCE = /^other-user-.+-(?:company|start)-source$/;

/**
 * Matches the one swept layer that carries a click listener.
 *
 * `updateCompanyLocation` is the only place a pin's layer is given one, and it
 * binds to the destination *icon* layer alone - not the label beside it, and
 * not either of the start-location layers, which `updateStartLocation` creates
 * without a listener. So this is narrower than `PIN_LAYER` on purpose: three
 * of the four layers one member's markers amount to never had anything bound.
 *
 * **A spurious `off` on those three would be a no-op that masks a later real
 * leak.** If one of them ever acquires a listener, the `off` already sitting
 * there would silently absorb the bug this function was fixed for, and the
 * count assertions in `clearOtherUserMarkers.clickHandler.test.tsx` would keep
 * passing while the live-listener array grew. Keeping the unbind aimed at the
 * layer that is actually bound is what keeps those assertions meaningful.
 */
const CLICKABLE_PIN_LAYER = /^other-user-.+-company-layer$/;

/**
 * Unbinds the point-click handler from a pin layer about to be removed.
 *
 * **The reason this is here at all**: `updateCompanyLocation`'s own `remove`
 * branch already does this, but nothing calls that branch for another user's
 * pin. `viewRouteClick` and `groupRouteClick` open by calling this sweep, so
 * the sweep is the only teardown path that runs in production - and removing a
 * layer does not remove the listeners scoped to it. Without this, every card
 * click left one more live handler on the destination layer it rebuilt, and a
 * single click ran the handler once per cycle (measured in Chromium against
 * real Mapbox GL: five invocations after four cycles). See SCRUM-722.
 *
 * `getPointClickHandler` returns the same function for a given map (a
 * `WeakMap`, see `handlers.ts`), which is what makes `off` able to name the
 * listener `on` added - a wrapper built here would be a different function
 * every call and could never unbind one.
 *
 * A missing handler unbinds nothing, the same guard the bind path uses:
 * `addMapEvents` registers it inside the map's `load`, before any of this
 * runs, so an unregistered map is a guard rather than a case.
 *
 * **Caught separately from the removal it precedes**, rather than sharing its
 * `try`. This is best-effort cleanup of a listener on a layer that is going
 * away regardless; letting it throw past this point would skip the
 * `removeLayer` after it and strand a visible pin on the map - which is the
 * failure this file's per-layer guards exist to prevent, and the worse of the
 * two outcomes by the reasoning in its own doc comment.
 */
const unbindPointClick = (map: mapboxgl.Map, layerId: string): void => {
  if (!CLICKABLE_PIN_LAYER.test(layerId)) return;

  try {
    const handlePointClick = getPointClickHandler(map);
    if (handlePointClick) {
      map.off("click", layerId, handlePointClick);
    }
  } catch (e) {
    console.warn(`Could not unbind click listener on ${layerId}:`, e);
  }
};

const clearOtherUserMarkers = (map: mapboxgl.Map): void => {
  const style = map.getStyle();
  if (!style) return;

  const sourceIds = new Set<string>();

  (style.layers ?? []).forEach((layer) => {
    const match = PIN_LAYER.exec(layer.id);
    if (!match) return;

    sourceIds.add(`${match[1]}-source`);

    // Guarded and caught individually for the reason `clearMarkers` already
    // gives: `getStyle()` returns a snapshot, and one layer that has gone
    // between the read and the removal must not abandon the rest of the sweep.
    try {
      if (map.getLayer(layer.id)) {
        unbindPointClick(map, layer.id);
        map.removeLayer(layer.id);
      }
    } catch (e) {
      console.warn(`Could not remove layer ${layer.id}:`, e);
    }
  });

  // A source whose layers never made it. `updateCompanyLocation` adds the
  // source and the layer from inside an async `loadImage` callback, so the two
  // are not added together and a sweep between them would otherwise strand the
  // source - which then blocks the next `addSource` under the same id.
  Object.keys(style.sources ?? {}).forEach((sourceId) => {
    if (PIN_SOURCE.test(sourceId)) {
      sourceIds.add(sourceId);
    }
  });

  sourceIds.forEach((sourceId) => {
    try {
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    } catch (e) {
      console.warn(`Could not remove source ${sourceId}:`, e);
    }

    const imageId = `${sourceId}-image`;
    try {
      if (map.hasImage(imageId)) {
        map.removeImage(imageId);
      }
    } catch (e) {
      console.warn(`Could not remove image ${imageId}:`, e);
    }
  });
};

export default clearOtherUserMarkers;
