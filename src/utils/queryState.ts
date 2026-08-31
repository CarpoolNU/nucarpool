/**
 * Collapses a React Query result into the three states the UI actually renders
 * differently (SCRUM-241).
 *
 * Every page used to destructure `data` alone, usually with an empty default:
 *
 *     const { data: recommendations = [] } = trpc.user.recommendations.me.useQuery();
 *
 * which makes a failed request indistinguishable from "no results", and on the
 * map page indistinguishable from "still loading" - `user.me` failing left
 * `data` undefined forever behind a spinner that never resolved. Deriving the
 * state in one place means the three cases cannot be conflated by accident, and
 * means the derivation itself is testable without a DOM.
 */

export type QueryStatus = "loading" | "error" | "ready";

export type QueryState = {
  status: QueryStatus;
  /** Re-runs the query. Every error state is paired with a way out of it. */
  retry: () => void;
};

/**
 * The slice of a React Query result this depends on. Declared structurally so it
 * can be satisfied by a plain object in a test as well as by `useQuery`.
 */
export type QueryLike = {
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
};

/**
 * `isError` is checked first on purpose. A query that has failed is also not
 * loading, but if it ever reports both, "error" is the state worth showing - a
 * spinner that is really a failure is the exact bug this replaces.
 */
export const toQueryState = (query: QueryLike): QueryState => ({
  status: query.isError ? "error" : query.isLoading ? "loading" : "ready",
  retry: () => {
    void query.refetch();
  },
});

/**
 * Combines the states of several queries feeding one view. Any failure wins,
 * then any load; "ready" needs all of them. Retrying retries all of them, since
 * from the user's side it is one list that did not appear.
 */
export const combineQueryStates = (...states: QueryState[]): QueryState => ({
  status: states.some((s) => s.status === "error")
    ? "error"
    : states.some((s) => s.status === "loading")
      ? "loading"
      : "ready",
  retry: () => {
    for (const state of states) {
      state.retry();
    }
  },
});
