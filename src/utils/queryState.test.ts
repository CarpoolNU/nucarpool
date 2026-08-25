import { QueryLike, combineQueryStates, toQueryState } from "./queryState";

/**
 * SCRUM-241: every page destructured `data` alone, so a failed query looked
 * exactly like an empty result - and on the map page like a load that never
 * finished. These tests pin the collapse from a React Query result to the three
 * states the UI renders differently, which is the part that decides whether a
 * user sees "nothing here" or "this broke, try again".
 */

/** `refetch` stays a mock so the retry assertions can see it. */
const query = (
  over: Partial<Omit<QueryLike, "refetch">> = {},
): QueryLike & { refetch: jest.Mock } => ({
  isLoading: false,
  isError: false,
  ...over,
  refetch: jest.fn(),
});

describe("toQueryState", () => {
  it("reports ready when the query has settled", () => {
    expect(toQueryState(query()).status).toBe("ready");
  });

  it("reports loading on a first load", () => {
    expect(toQueryState(query({ isLoading: true })).status).toBe("loading");
  });

  it("reports error on a failure", () => {
    expect(toQueryState(query({ isError: true })).status).toBe("error");
  });

  /**
   * The precedence that matters. A spinner standing in for a failure is the
   * original bug, so if a result ever claims both, the failure has to win.
   */
  it("prefers error over loading when a result claims both", () => {
    expect(toQueryState(query({ isError: true, isLoading: true })).status).toBe(
      "error",
    );
  });

  it("retries by refetching, and does not refetch until asked", () => {
    const q = query({ isError: true });
    const state = toQueryState(q);

    expect(q.refetch).not.toHaveBeenCalled();

    state.retry();

    expect(q.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("combineQueryStates", () => {
  const ready = () => toQueryState(query());
  const loading = () => toQueryState(query({ isLoading: true }));
  const failed = () => toQueryState(query({ isError: true }));

  it("is ready only when every query is", () => {
    expect(combineQueryStates(ready(), ready()).status).toBe("ready");
  });

  it("is loading when any query still is", () => {
    expect(combineQueryStates(ready(), loading()).status).toBe("loading");
  });

  it("is error when any query failed, whatever the others are doing", () => {
    expect(combineQueryStates(ready(), loading(), failed()).status).toBe(
      "error",
    );
  });

  it("retries every underlying query, since the user sees one missing list", () => {
    const a = query();
    const b = query({ isError: true });

    combineQueryStates(toQueryState(a), toQueryState(b)).retry();

    expect(a.refetch).toHaveBeenCalledTimes(1);
    expect(b.refetch).toHaveBeenCalledTimes(1);
  });

  it("is ready with nothing to combine, rather than stuck", () => {
    expect(combineQueryStates().status).toBe("ready");
  });
});
