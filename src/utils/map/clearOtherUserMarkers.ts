/**
 * Takes every *other* user's pin off the map — icon, label, source and image.
 *
 * **Asks the map which layers exist rather than remembering which were added.**
 * Cleanup used to be keyed by identity, so removing a pin required having
 * remembered whose it was; `onViewGroupRoute` adds one per group member and
 * remembered none, so nothing ever removed them and they survived a route drawn
 * over the top, a tab change and every later preview. A sweep cannot forget a
 * pin, and a bookkeeping slip here is invisible until somebody looks at the map.
 *
 * **A sweep is safe because of where it is called** — at the *start* of each
 * handler, before that handler draws its own pins. `onViewGroupRoute` sweeps
 * and then immediately re-adds every member, so its pins are never the ones
 * erased. Calling this anywhere else needs that ordering re-established first.
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
 * A regex rather than `id.replace("-layer", "-source")`, which is what
 * `clearRiderStartMarkers` did: on a text layer that produces
 * `...-start-text-source`, a source that has never existed. It went unnoticed
 * only because its `-start-layer` filter never matched a text layer in the
 * first place.
 */
const PIN_LAYER = /^(other-user-.+-(?:company|start))-(?:text-)?layer$/;

/** Matches a pin source directly, for one that outlived its layers. */
const PIN_SOURCE = /^other-user-.+-(?:company|start)-source$/;

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
