/**
 * Pulls the rest of a keyset-paged list.
 *
 * **Why this exists at all.** Comments are ordered oldest-first, so a new
 * reply lands on the *last* page of its thread. A reader who has not paged to
 * the end therefore posts a reply and sees nothing happen — invalidating the
 * query refetches the pages they already hold, and theirs is not among them.
 * After posting, the thread is drained forward so the author lands on their
 * own words. The feed has the opposite ordering and never needs this.
 *
 * `fetchNext` is expected to resolve with the query's state *after* that fetch,
 * which is what `useInfiniteQuery`'s `fetchNextPage()` does — the loop reads
 * its answer from the result rather than from a closed-over `hasNextPage` that
 * would still hold the value it had before the first await.
 *
 * `maxFetches` is not tuning. A cursor that always reports another page is a
 * server bug, and without a cap this loop is unbounded inside the click that
 * posted the reply: it would hang the composer instead of failing visibly.
 */
export const drainPages = async (
  hasNextPage: boolean,
  fetchNext: () => Promise<{ hasNextPage: boolean }>,
  maxFetches = 20,
): Promise<number> => {
  let fetched = 0;
  let more = hasNextPage;

  while (more && fetched < maxFetches) {
    more = (await fetchNext()).hasNextPage;
    fetched += 1;
  }

  return fetched;
};

/**
 * Pulls further pages only until the list has something on it.
 *
 * **For a list whose pages can come back empty with more behind them.** The
 * saved list is the one: it pages over save rows and then drops the ones whose
 * post has been deleted, hidden, or written by someone the reader has since
 * blocked, so a page can legitimately yield no posts while the cursor points
 * at plenty more saves. Without this the reader is shown "nothing saved yet"
 * above a list they can see is not empty.
 *
 * **It stops at the first page that yields a row**, rather than draining to
 * the end as {@link drainPages} does. One rotted page in front of five hundred
 * saves should cost one extra request, not five hundred — and from there the
 * reader pages by hand like any other list.
 *
 * `maxFetches` is the same safety cap and exists for the same reason: a cursor
 * that always reports another page is a server bug, and an unbounded loop here
 * would spin requests instead of failing visibly.
 */
export const drainWhileEmpty = async (
  state: { hasNextPage: boolean; itemCount: number },
  fetchNext: () => Promise<{ hasNextPage: boolean; itemCount: number }>,
  maxFetches = 20,
): Promise<number> => {
  let fetched = 0;
  let current = state;

  while (
    current.itemCount === 0 &&
    current.hasNextPage &&
    fetched < maxFetches
  ) {
    current = await fetchNext();
    fetched += 1;
  }

  return fetched;
};

/**
 * Whether a cached keyset-paged list has a page behind the ones it holds.
 *
 * **Only the last page can answer.** Every page before it carries a cursor by
 * construction, so asking any other one is asking a question whose answer is
 * always yes. An absent cache — nothing held at all — has nothing behind it
 * either, because there is no page on screen to drain past.
 *
 * This exists so a drain can be seeded from the pages a refetch just wrote
 * into the cache rather than from a query result captured before it; see
 * {@link drainAfterReply}.
 */
export const hasMorePages = (
  pages: readonly { nextCursor: string | null }[] | undefined,
): boolean => {
  const last = pages?.[pages.length - 1];
  return last ? last.nextCursor !== null : false;
};

/**
 * Drains a thread forward after a reply was posted to it.
 *
 * **The seed is the whole point.** {@link drainPages} already refuses to read
 * `hasNextPage` from a closure for every page after the first — and the first
 * one was the exception that let SCRUM-691 through. A React Query result is
 * rebuilt each render and never mutated in place, so a `hasNextPage` captured
 * in the render that built the post handler still holds the value it had
 * *before* the reply existed. Harmless on a thread that already had a next
 * page; wrong exactly at the page boundary, where the reply is what creates
 * page two: the seed says `false`, nothing is drained, and the author is shown
 * a thread without their own words in it.
 *
 * So the seed comes out of `refresh`'s result, by the same rule the loop
 * follows. `refresh` is expected to settle the refetch and then report the
 * state it produced — there is no argument here that could hold a stale one.
 */
export const drainAfterReply = async (
  refresh: () => Promise<{ hasNextPage: boolean }>,
  fetchNext: () => Promise<{ hasNextPage: boolean }>,
  maxFetches = 20,
): Promise<number> =>
  drainPages((await refresh()).hasNextPage, fetchNext, maxFetches);
