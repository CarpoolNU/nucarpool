import {
  HELD_QUERY_STATE,
  QueryLike,
  combineQueryStates,
  toQueryState,
} from "./queryState";

/**
 * Every page used to destructure `data` alone, so a failed query looked
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

describe("HELD_QUERY_STATE", () => {
  /**
   * The distinction this exists for. React Query v5 defines `isLoading` as
   * `isPending && isFetching`, so a query held at `enabled: false` is not
   * fetching and `toQueryState` reads it as `ready` - correct for a gate
   * meaning "this role never needs the data", wrong for one meaning "not yet".
   *
   * This is the measurement rather than a claim about the library: a real
   * disabled query is asserted to report `ready` in
   * `queryStateDisabled.test.tsx`, which is what makes the constant necessary.
   */
  it("reports loading, which a disabled query does not", () => {
    expect(HELD_QUERY_STATE.status).toBe("loading");
  });

  it("combines as a load, so a held query holds the whole view", () => {
    expect(
      combineQueryStates(toQueryState(query()), HELD_QUERY_STATE).status,
    ).toBe("loading");
  });

  /**
   * A failure elsewhere still wins. `AdminData` holds its series query until
   * the slider bounds exist, and a reader whose stats query has already failed
   * is owed the error then rather than after the hold clears.
   */
  it("does not mask a failure in a sibling query", () => {
    expect(
      combineQueryStates(
        toQueryState(query({ isError: true })),
        HELD_QUERY_STATE,
      ).status,
    ).toBe("error");
  });

  it("retries without throwing, there being nothing to refetch", () => {
    expect(() => HELD_QUERY_STATE.retry()).not.toThrow();
  });
});
