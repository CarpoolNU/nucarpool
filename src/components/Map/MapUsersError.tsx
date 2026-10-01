import { QueryError } from "../QueryError";
import type { QueryState } from "../../utils/queryState";

/**
 * The map's own failure state: `mapbox.geoJsonUserList` could not be loaded, so
 * the map has no pins.
 *
 * **Why this exists at all.** That query was the one list on `/` that
 * SCRUM-509 missed. Every other one goes through `toQueryState` and renders a
 * `QueryError` with a retry; this one was destructured to `data` alone, so a
 * Mapbox or server failure left the primary map with no pins, no message and
 * nothing to press - indistinguishable from an area where nobody has signed
 * up. That is the worst failure mode a matching product has, because it looks
 * like an answer rather than an outage.
 *
 * **Why it is a component rather than a branch inside `index.tsx`.** For the
 * reason `RecentreButton`'s docblock gives: that file is ~1300 lines behind
 * Mapbox, NextAuth and a dozen tRPC queries and cannot be rendered in jsdom, so
 * a failure state living inside it is a failure state nothing can assert. Here,
 * "a failed map query shows an error and offers a retry" is a test.
 *
 * **Why it overlays rather than replaces.** A full-page treatment would be
 * wrong: the map still pans, the sidebar lists still have their own data and
 * report their own failures, and only this one layer is missing. So it takes
 * the middle of the map - the space the absent pins would have filled - and
 * leaves everything else reachable. The outer box does not intercept pointer
 * events, so the map can still be panned and zoomed around the panel; only the
 * panel itself is clickable, which is all the retry needs.
 *
 * **Where the caller must put it.** Inside `#map`, like `MapLegend` and
 * `RecentreButton`, so it is positioned against the map rather than against the
 * viewport - see the note on the recentre button for what being a sibling of
 * that container cost it. Two consequences follow from that container being a
 * stacking context: nothing here can paint above the explore sheet, so on
 * mobile an expanded sheet covers this panel. That is the established
 * constraint for everything inside `#map` rather than something new, and it
 * costs this panel little - a user looking at the map has the sheet down, and a
 * user with the sheet up is reading a list that reports its own failures.
 *
 * Renders nothing unless the query has actually failed, so the caller does not
 * need its own conditional.
 */
export const MapUsersError = ({ state }: { state: QueryState }) => {
  if (state.status !== "error") {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
      <div className="pointer-events-auto max-w-sm rounded-xl border border-gray-200 bg-white shadow-lg">
        <QueryError subject="the users on the map" onRetry={state.retry} />
      </div>
    </div>
  );
};
