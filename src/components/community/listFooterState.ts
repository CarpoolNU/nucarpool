export type ListFooterInput = {
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  itemCount: number;
  pagesLoaded: number;
  /**
   * The query's failure, as the message it came with, or `null`.
   *
   * **Required, so that a new list has to answer the question.** The three
   * pages this helper was written for each went a release telling readers
   * "No posts here yet" over a query the server had refused (SCRUM-692),
   * which is what an optional field here would have let the fourth do too.
   */
  error: string | null;
};

export type ListFooterState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "more"; busy: boolean; error?: string }
  | { kind: "end" }
  | { kind: "none" };

/**
 * Reads a paged list's query state as the one thing its footer should say.
 *
 * **An error replaces the list only when the list is empty.** This is the one
 * rule `queueViewState` answers differently, and the difference is deliberate
 * rather than drift: that page blanks its queue on any error because the rows
 * it holds carry live Hide buttons, and leaving them under a message saying
 * the queue could not be loaded would invite a moderator to act on a view they
 * have just been told is unreliable. A feed has no such buttons. Discarding
 * twenty posts already read because the twenty-first page failed costs the
 * reader more than the failure did, so here the rows stay and the news rides
 * on the control that fetches the next page — which is also the retry, since
 * pressing "Load more" again is the request that failed.
 *
 * **An error outranks `isLoading`.** React Query never reports both for one
 * query, but a page may OR its own work into the flag: `saved.tsx` adds the
 * drain that pulls past pages of saves whose posts are gone. A drain whose
 * fetch failed still looks like loading from outside, and "Loading…" over a
 * failure is the same lie as "Nothing saved yet" in a quieter voice.
 *
 * **A failure over a list that is already whole is not reported.** With rows
 * on screen and no next page, the only way here is a refetch that failed
 * behind a list the reader can still read — the last good answer, with nothing
 * missing from it and no control to retry on. The write that triggered the
 * refetch reports its own failure where it happened.
 */
export const listFooterState = ({
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  itemCount,
  pagesLoaded,
  error,
}: ListFooterInput): ListFooterState => {
  if (error !== null && itemCount === 0)
    return { kind: "error", message: error };
  if (isLoading) return { kind: "loading" };
  if (itemCount === 0) return { kind: "empty" };
  if (hasNextPage) {
    const more = { kind: "more" as const, busy: isFetchingNextPage };
    return error === null ? more : { ...more, error };
  }
  return pagesLoaded > 1 ? { kind: "end" } : { kind: "none" };
};
