import mapboxgl from "mapbox-gl";

/**
 * Takes every *other* user's pin off the map — icon, label, source and image.
 *
 * Pin cleanup used to be keyed by identity: `updateCompanyLocation` and
 * `updateStartLocation` name their layers after the user
 * (`other-user-<id>-company-layer`), and the only way to remove one was to call
 * the same function back with `remove: true` — which meant you had to have
 * remembered whose pin it was. `onViewGroupRoute` adds a pin for every group
 * member and remembered none of them, so **nothing ever removed them**
 * (SCRUM-391). They survived an individual route being drawn over the top, a
 * tab change, and every later group preview.
 *
 * The three functions that looked like cleanup each missed:
 *
 * - `clearMarkers` swept `-text-layer` and nothing else, so a group member's
 *   *label* went and their *icon* stayed. An unlabelled pin is the worst of the
 *   two states, and it is why the leftovers read as unexplained destinations
 *   rather than as an obviously stale overlay.
 * - `clearRiderStartMarkers` swept `-start-layer`, so start markers went and
 *   destination pins stayed. (It also filtered `!id.includes("driver")`, which
 *   read as "riders only" but excluded nothing: a layer id carries a cuid, not
 *   a role. Deleted with the file.)
 * - the page's `sidebarType` effect removed the single pin it was tracking,
 *   which after SCRUM-379 is the individual View Route pin. Group pins were
 *   never tracked.
 *
 * **The map already knows which layers exist, so ask it.** That is the whole
 * change in approach: a sweep cannot forget a pin, where bookkeeping can, and a
 * bookkeeping slip here is invisible until somebody looks at the map. It also
 * retires the `DestinationMarkerRef` that SCRUM-379 introduced, along with
 * `ViewRoutePlan.removesDestinationMarkerFor` — with a sweep at the top of both
 * handlers there is no remembered pin left to name.
 *
 * `viewRoutePlan.ts` used to argue the opposite: "Only ever names the one
 * remembered pin, never a sweep of every `other-user-*` layer.
 * `onViewGroupRoute` puts a pin on every group member, and a sweep here would
 * erase them." That was right about the danger and wrong about the remedy. A
 * sweep is safe **because of where it is called** — at the *start* of each
 * handler, before that handler draws its own pins. `onViewGroupRoute` sweeps
 * and then immediately re-adds every member, so its pins are never the ones
 * erased.
 *
 * ## What it deliberately does not touch
 *
 * Only the `other-user-` prefix. Removing too much is the likelier failure and
 * the harder one to notice, so these stay, and `clearOtherUserMarkers.test.ts`
 * holds them there:
 *
 * - `clusters`, `cluster-count`, `riders`, `drivers` and their
 *   `company-locations` source — the discovery map itself.
 * - `layer-with-pulsing-dot` / `dot-point` — the viewer's own position.
 * - `current-user-company-layer` — the viewer's own destination.
 * - `route` — the line being drawn. Its own lifecycle is `clearDirections`.
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
