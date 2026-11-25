import type { SortKey } from "../../server/community/shared/cursor";

/**
 * What the feed is currently showing, as the URL records it.
 *
 * **The URL is the state.** A Top feed and a filtered feed both have to be
 * shareable — "look at the top parking posts" is a link, not a sequence of
 * clicks — so neither the sort nor the category lives in component state.
 * These two functions are the whole of the reading and writing, kept here
 * rather than inline so the parsing has tests: `router.query` hands back
 * `string | string[] | undefined` and the sort is attacker-supplied text.
 */
export type FeedView = {
  categorySlug?: string;
  /**
   * What the reader is searching for, or absent for the unfiltered feed.
   *
   * **A term is what makes a view a search**, and a search lives at
   * `/community/search` — so this one field decides the route as well as the
   * query string. See {@link feedHref}.
   */
  term?: string;
  sort: SortKey;
};

/** Next gives `string[]` for a repeated query parameter. */
type QueryValue = string | string[] | undefined;

const first = (value: QueryValue): string | undefined => {
  const single = Array.isArray(value) ? value[0] : value;
  return single === undefined || single.length === 0 ? undefined : single;
};

/**
 * Reads a feed view out of `router.query`.
 *
 * **An unrecognized sort becomes `"new"` rather than an error.** A hand-edited
 * or stale URL should show a feed, and the one order that is always correct to
 * show is the default — the server would refuse the unknown value anyway, so
 * falling back here is what keeps that refusal from reaching a reader.
 */
export const readFeedView = (query: {
  category?: QueryValue;
  q?: QueryValue;
  sort?: QueryValue;
}): FeedView => {
  const categorySlug = first(query.category);
  // Trimmed, and dropped entirely when nothing is left — the same reading
  // `normalizeSearchTerm` gives it on the server. A page that disagreed would
  // announce "no results for ' '" over a feed it never actually filtered.
  const term = first(query.q)?.trim() || undefined;
  const sort: SortKey = first(query.sort) === "top" ? "top" : "new";
  return {
    ...(term === undefined ? {} : { term }),
    ...(categorySlug === undefined ? {} : { categorySlug }),
    sort,
  };
};

/**
 * The link to a view — the inverse of {@link readFeedView}.
 *
 * **`sort=new` is omitted**, so the default feed keeps the bare `/community`
 * URL it had before Top existed and every link written against it still lands
 * on the same page.
 *
 * **A view with a term resolves to `/community/search`, and that is why one
 * function owns both routes** (SCRUM-683). The category chips and the sort
 * tabs are the same components on both pages, each built from the current view
 * with one field changed; if the route were the caller's business, a chip on
 * the search page would have to remember to carry the term and a chip on the
 * feed would have to remember not to invent one. Here, neither page knows
 * there are two routes.
 *
 * The term goes in `q` rather than `search`, because `q` is what a URL bar and
 * every other search page on the web already use.
 */
export const feedHref = (view: FeedView): string => {
  const params = new URLSearchParams();
  // `q` first, so a shared search URL reads as a search before it reads as a
  // filter.
  if (view.term !== undefined) {
    params.set("q", view.term);
  }
  if (view.categorySlug !== undefined) {
    params.set("category", view.categorySlug);
  }
  if (view.sort === "top") {
    params.set("sort", "top");
  }
  const query = params.toString();
  const path = view.term === undefined ? "/community" : "/community/search";
  return query.length > 0 ? `${path}?${query}` : path;
};

/**
 * Where the search box goes when someone presses Enter.
 *
 * **A new search is always board-wide**, and deliberately does not inherit the
 * category or the sort the reader happened to be looking at. The complaint
 * SCRUM-683 answers is that an answer already on the board could not be found;
 * silently scoping a search to the one category someone was browsing is a way
 * to keep not finding it. Narrowing afterwards is what the chips on the
 * results page are for, and that path is visible — this one would not be.
 *
 * **An empty box returns to the feed** rather than searching for nothing,
 * because clearing the box and pressing Enter is how a reader leaves a search.
 */
export const searchSubmitHref = (raw: string): string => {
  const term = raw.trim();
  return feedHref(term.length === 0 ? { sort: "new" } : { term, sort: "new" });
};
