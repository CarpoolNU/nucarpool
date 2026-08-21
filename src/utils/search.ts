import { Dispatch, SetStateAction, useEffect } from "react";
import { toast } from "react-toastify";
import { trpc } from "./trpc";
import { CarpoolFeature } from "./types";
import type { MapboxSearchType } from "./map/mapboxUrls";

/**
 * How long an autocomplete result is served from the React Query cache before
 * Mapbox is asked again.
 *
 * Addresses do not move, so this is bounded by how stale a suggestion list may
 * be rather than by correctness. Five minutes is long enough to cover a user
 * backspacing and retyping, or filling in home and company fields in one
 * sitting, which is where the repeated requests came from.
 */
export const SEARCH_STALE_TIME_MS = 5 * 60 * 1000;
export const SEARCH_CACHE_TIME_MS = 10 * 60 * 1000;

/**
 * Listens to updates from `value` — on updates, new queries are sent to Mapbox
 * search, with customization of `type` as well as a function to handle the
 * return values.
 *
 * Mapbox is metered, so this deliberately uses an ordinary cached query keyed
 * on the search text (SCRUM-244). It used to declare the query `enabled: false`
 * and call `refetch()` from an effect on every debounced change — `refetch` is
 * imperative and ignores the cache, so retyping text that had already been
 * searched always went back out to Mapbox. Keying on `value` means a repeat is
 * free, and the two hooks mounted on the map page share a cache entry whenever
 * they are looking for the same thing.
 *
 * @param value the search value to "listen" to
 * @param type which category of place to search for
 * @param setFunc the function which will be called to update with new features
 */
export default function useSearch({
  value,
  type,
  setFunc,
}: {
  value: string;
  type: MapboxSearchType;
  setFunc: Dispatch<SetStateAction<CarpoolFeature[]>>;
}) {
  // Canonicalised so " boston" and "boston " share one cache entry, and so
  // whitespace alone does not count as a search. The procedure trims too.
  const query = value.trim();

  const { data, error } = trpc.mapbox.search.useQuery(
    { value: query, types: type },
    {
      enabled: query.length > 0,
      staleTime: SEARCH_STALE_TIME_MS,
      cacheTime: SEARCH_CACHE_TIME_MS,
      // The user is still typing; the next keystroke is a better retry than
      // three immediate ones against a metered API.
      retry: false,
    },
  );

  useEffect(() => {
    /* the standard Feature type does not describe the full breadth of
    properties available such as "place_name" and "center" */
    if (data) {
      setFunc((data.features ?? []) as CarpoolFeature[]);
    }
  }, [data, setFunc]);

  useEffect(() => {
    if (error) {
      toast.error(`Something went wrong: ${error}`);
    }
  }, [error]);
}
