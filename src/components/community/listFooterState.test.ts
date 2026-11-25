import { listFooterState } from "./listFooterState";

describe("listFooterState", () => {
  // The five inputs are exactly what `useInfiniteQuery` exposes plus the row
  // count, so a page can hand this its query state without interpreting any of
  // it first. That is the point: the interpretation is here, once, instead of
  // as a ternary chain in each page.
  const state = (over: Partial<Parameters<typeof listFooterState>[0]> = {}) =>
    listFooterState({
      isLoading: false,
      isFetchingNextPage: false,
      hasNextPage: false,
      itemCount: 5,
      pagesLoaded: 1,
      error: null,
      ...over,
    });

  it("reports loading while the first page is in flight", () => {
    expect(state({ isLoading: true, itemCount: 0 })).toEqual({
      kind: "loading",
    });
  });

  it("reports empty when the first page came back with nothing", () => {
    expect(state({ itemCount: 0 })).toEqual({ kind: "empty" });
  });

  it("offers more when the server returned a cursor", () => {
    expect(state({ hasNextPage: true })).toEqual({ kind: "more", busy: false });
  });

  it("keeps offering more while the next page is in flight, marked busy", () => {
    // Not a separate kind: the control stays on screen and disables, so that
    // the page does not reflow out from under the pointer that just clicked it.
    expect(state({ hasNextPage: true, isFetchingNextPage: true })).toEqual({
      kind: "more",
      busy: true,
    });
  });

  it("confirms the end once the reader has actually paged", () => {
    expect(state({ pagesLoaded: 2 })).toEqual({ kind: "end" });
  });

  it("says nothing at the end of a list that never needed a second page", () => {
    // A five-post board does not need telling it has five posts. The terminus
    // is only informative to someone who pressed the control to get there.
    expect(state({ pagesLoaded: 1 })).toEqual({ kind: "none" });
  });

  it("reports loading rather than empty before the first page resolves", () => {
    // Order matters: `useInfiniteQuery` reports an item count of zero while the
    // first request is open, and an empty state flashed for one frame reads as
    // "there is nothing here" on a board that is merely slow.
    expect(state({ isLoading: true, itemCount: 0, hasNextPage: true })).toEqual(
      {
        kind: "loading",
      },
    );
  });

  it("reports empty rather than offering more when a filter matched nothing", () => {
    expect(state({ itemCount: 0, hasNextPage: true })).toEqual({
      kind: "empty",
    });
  });

  it("reports the error when the first page failed", () => {
    // The kind this file exists to stop being `empty`: a query that was
    // refused returns no rows, and "nothing here" is a claim about the board
    // rather than about the request (SCRUM-692).
    expect(
      state({ error: "No category with that name.", itemCount: 0 }),
    ).toEqual({
      kind: "error",
      message: "No category with that name.",
    });
  });

  it("reports the error over a loading flag the page assembled itself", () => {
    // `isLoading` is the query's, except where a page ORs its own work into it
    // — `saved.tsx` adds its drain. A drain whose page failed is still fetching
    // by that flag, so the error has to outrank it or the failure reads as a
    // list still arriving.
    expect(
      state({ error: "You can't see that.", isLoading: true, itemCount: 0 }),
    ).toEqual({ kind: "error", message: "You can't see that." });
  });

  it("keeps the rows on screen when a later page failed", () => {
    // The divergence from `queueViewState`, which blanks its queue: twenty
    // posts already read are not worth spending to report that the
    // twenty-first did not arrive.
    expect(
      state({
        error: "Something went wrong.",
        hasNextPage: true,
        itemCount: 20,
      }),
    ).toEqual({ kind: "more", busy: false, error: "Something went wrong." });
  });

  it("keeps the control marked busy while the page that failed is retried", () => {
    expect(
      state({
        error: "Something went wrong.",
        hasNextPage: true,
        isFetchingNextPage: true,
      }),
    ).toEqual({ kind: "more", busy: true, error: "Something went wrong." });
  });

  it("says nothing of a failure over a list that is already whole", () => {
    // Nothing is missing from the screen and there is no control to retry on,
    // so the only reachable case — a refetch that failed over a complete list
    // — would be a red line with no action attached to it.
    expect(state({ error: "Something went wrong.", pagesLoaded: 2 })).toEqual({
      kind: "end",
    });
  });
});
