import {
  drainAfterReply,
  drainPages,
  drainWhileEmpty,
  hasMorePages,
} from "./drainPages";

describe("drainPages", () => {
  /** A fetcher that reports `remaining` further pages, one per call. */
  const fetcher = (remaining: number) => {
    let left = remaining;
    const calls: number[] = [];
    return {
      calls,
      fetchNext: async () => {
        calls.push(left);
        left -= 1;
        return { hasNextPage: left > 0 };
      },
    };
  };

  it("fetches nothing when the list is already complete", async () => {
    const { calls, fetchNext } = fetcher(5);

    await drainPages(false, fetchNext);

    expect(calls).toHaveLength(0);
  });

  it("fetches until the server stops offering a next page", async () => {
    const { calls, fetchNext } = fetcher(3);

    const fetched = await drainPages(true, fetchNext);

    expect(fetched).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("stops at the safety cap rather than looping forever", async () => {
    // A cursor that always reports another page is a server bug, not an
    // unusually long thread. Without the cap this loop is unbounded and runs
    // inside the click that posted a reply, so it would hang the composer
    // rather than fail visibly.
    const endless = async () => ({ hasNextPage: true });

    const fetched = await drainPages(true, endless, 4);

    expect(fetched).toBe(4);
  });

  it("reports how many pages it pulled, so a caller can tell a short thread from a capped one", async () => {
    const { fetchNext } = fetcher(2);

    expect(await drainPages(true, fetchNext, 10)).toBe(2);
  });
});

describe("drainWhileEmpty", () => {
  /**
   * A fetcher whose pages are all empty until `rowsAt`, which is what a saved
   * list looks like when the newest saves point at posts that have since been
   * deleted, hidden, or written by someone the reader has blocked.
   */
  const fetcher = (pages: number, rowsAt: number) => {
    let page = 0;
    let rows = 0;
    const calls: number[] = [];
    return {
      calls,
      fetchNext: async () => {
        page += 1;
        calls.push(page);
        if (page >= rowsAt) rows += 1;
        return { hasNextPage: page < pages, itemCount: rows };
      },
    };
  };

  it("fetches nothing when the first page already has rows", async () => {
    const { calls, fetchNext } = fetcher(5, 1);

    await drainWhileEmpty({ hasNextPage: true, itemCount: 3 }, fetchNext);

    expect(calls).toHaveLength(0);
  });

  it("fetches nothing when there is no next page to pull", async () => {
    const { calls, fetchNext } = fetcher(5, 1);

    await drainWhileEmpty({ hasNextPage: false, itemCount: 0 }, fetchNext);

    expect(calls).toHaveLength(0);
  });

  it("stops at the first page that yields a row", async () => {
    // The point of stopping: a saved list with one rotted page and five
    // hundred saves behind it should cost one extra request, not five hundred.
    const { calls, fetchNext } = fetcher(50, 2);

    const fetched = await drainWhileEmpty(
      { hasNextPage: true, itemCount: 0 },
      fetchNext,
    );

    expect(fetched).toBe(2);
    expect(calls).toEqual([1, 2]);
  });

  it("gives up when the list runs out while still empty", async () => {
    const { fetchNext } = fetcher(3, 99);

    const fetched = await drainWhileEmpty(
      { hasNextPage: true, itemCount: 0 },
      fetchNext,
    );

    expect(fetched).toBe(3);
  });

  it("stops at the safety cap rather than looping forever", async () => {
    const endless = async () => ({ hasNextPage: true, itemCount: 0 });

    expect(
      await drainWhileEmpty({ hasNextPage: true, itemCount: 0 }, endless, 4),
    ).toBe(4);
  });
});

describe("hasMorePages", () => {
  it("reports nothing more when the thread is not in the cache at all", () => {
    expect(hasMorePages(undefined)).toBe(false);
  });

  it("reports nothing more when the last page carries no cursor", () => {
    expect(hasMorePages([{ nextCursor: null }])).toBe(false);
  });

  it("reports more when the last page carries a cursor", () => {
    expect(hasMorePages([{ nextCursor: "c1" }])).toBe(true);
  });

  it("follows the last page rather than an earlier one", () => {
    // Every page but the last one has a cursor by construction, so asking any
    // other page is asking a question whose answer is always yes.
    expect(hasMorePages([{ nextCursor: "c1" }, { nextCursor: null }])).toBe(
      false,
    );
  });
});

describe("drainAfterReply", () => {
  const fetcher = (remaining: number) => {
    let left = remaining;
    const calls: number[] = [];
    return {
      calls,
      fetchNext: async () => {
        calls.push(left);
        left -= 1;
        return { hasNextPage: left > 0 };
      },
    };
  };

  it("seeds the drain from the refreshed thread, not from the one before the reply", async () => {
    // SCRUM-691. The reply that takes a thread from exactly one full page to
    // one more is the case: before it, the thread's last page had no cursor,
    // so a seed captured before the refresh says there is nothing to drain to
    // and the author never sees their own words.
    const { calls, fetchNext } = fetcher(1);
    const refresh = async () => ({ hasNextPage: true });

    const fetched = await drainAfterReply(refresh, fetchNext);

    expect(fetched).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("fetches nothing when the refreshed thread ends on the page already held", async () => {
    const { calls, fetchNext } = fetcher(5);
    const refresh = async () => ({ hasNextPage: false });

    await drainAfterReply(refresh, fetchNext);

    expect(calls).toHaveLength(0);
  });

  it("still drains a thread that already had further pages", async () => {
    // The SCRUM-680 behaviour this protects.
    const { fetchNext } = fetcher(3);
    const refresh = async () => ({ hasNextPage: true });

    expect(await drainAfterReply(refresh, fetchNext)).toBe(3);
  });

  it("keeps the safety cap of the drain it wraps", async () => {
    const endless = async () => ({ hasNextPage: true });

    expect(
      await drainAfterReply(async () => ({ hasNextPage: true }), endless, 4),
    ).toBe(4);
  });
});
