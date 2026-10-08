/**
 * What `buildTrpcMock` guarantees to the fifteen suites built on it.
 *
 * The harness is only worth sharing if it is worth trusting, and the one thing
 * a shared fake must not do is quietly become a *weaker* fake than the code it
 * replaced. So this file asserts against the real React Query client, through
 * the real `jest.mock` factory form, rather than against the object literal
 * `buildTrpcMock` returns.
 *
 * Mocking `../utils/trpc` here rather than calling `buildTrpcMock` directly is
 * deliberate and is itself under test: the `require`-inside-factory form and
 * the module registry the spies live in are both load-bearing, and neither is
 * exercised by a direct call. If the factory could not reach this module, or
 * reached a second copy of it, `trpcSpies` below would read spies that nothing
 * ever called and every count assertion would pass at zero.
 *
 * `enabled: false` is the measurement the whole design rests on;
 * `utils/queryStateDisabled.test.tsx` pins the same fact one layer down,
 * against React Query with no tRPC shape over it.
 */

import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc as realTrpc, realTimeQueryOptions } from "../utils/trpc";
import { trpcSpies, resetTrpcSpies } from "./trpcHarness";

/**
 * The paths below are invented, not the real router's, because what is under
 * test is the *expansion* rather than any particular procedure. Reading them
 * through `AppRouter`'s types would therefore check the wrong thing and reject
 * every one of them, so the decorated type is dropped here and only here.
 */
const trpc = realTrpc as unknown as Record<string, any>;

/**
 * Deliberately varied: two depths of nesting, every hook shape, both inert
 * shapes, and one `invalidate` override that reaches the live client.
 */
jest.mock("../utils/trpc", () =>
  require("./trpcHarness").buildTrpcMock(
    {
      "user.admin.getAllUsers": {
        query: (input: unknown) => ["row", input],
      },
      "user.me": {
        query: async () => ({ id: "user-1" }),
      },
      "user.admin.getReports": {
        infiniteQuery: (input: unknown, context: { pageParam?: unknown }) => ({
          reports: [input, context.pageParam],
          nextCursor: undefined,
        }),
      },
      "user.requests.create": {
        mutation: (variables: unknown) => ({ created: variables }),
      },
      "mapbox.search": { inertQuery: true },
      "user.emails.sendRequestNotification": { inertMutation: true },
      // Utils-only: declared so `useUtils()` carries the path, with no hook of
      // its own. `invalidate` reaches the cache, which the default does not.
      "user.recommendations.me": {
        invalidate: (queryClient: QueryClient) =>
          queryClient.invalidateQueries({
            queryKey: ["user.admin.getAllUsers"],
          }),
      },
    },
    { realTimeQueryOptions: { refetchInterval: 1234 } },
  ),
);

const withClient = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  resetTrpcSpies();
});

describe("nested-path expansion", () => {
  it("places each dotted path at its own depth, with useUtils on the root", () => {
    expect(typeof trpc.user.admin.getAllUsers.useQuery).toBe("function");
    expect(typeof trpc.user.admin.getReports.useInfiniteQuery).toBe("function");
    expect(typeof trpc.user.me.useQuery).toBe("function");
    expect(typeof trpc.user.requests.create.useMutation).toBe("function");
    expect(typeof trpc.useUtils).toBe("function");

    // A path declares only the hooks its stub asked for. A component calling
    // the wrong one should fail loudly rather than get an inert stand-in.
    expect(trpc.user.me.useMutation).toBeUndefined();
  });

  it("passes through the module's other named exports", () => {
    expect(realTimeQueryOptions).toEqual({ refetchInterval: 1234 });
  });
});

describe("useQuery", () => {
  it("runs through the real client: pending, then the stub's value", async () => {
    const { result } = renderHook(
      () => trpc.user.admin.getAllUsers.useQuery({ page: 1 }),
      { wrapper: withClient },
    );

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(["row", { page: 1 }]);

    // The stub sees the tRPC input, and React Query's own context beside it.
    expect(trpcSpies("user.admin.getAllUsers").queryFn).toHaveBeenCalledTimes(
      1,
    );
    expect(trpcSpies("user.admin.getAllUsers").queryFn).toHaveBeenCalledWith(
      { page: 1 },
      expect.objectContaining({
        queryKey: ["user.admin.getAllUsers", { page: 1 }],
      }),
    );
  });

  /**
   * That `options` is spread **at all**.
   *
   * This and the disabled-query case below are the two that fail if the spread
   * is deleted from `trpcHarness.ts` - measured, by deleting it. Spreading is
   * what carries a caller's `enabled` to the client, so a fix that worked out
   * a gate but forgot to pass it cannot look correct here.
   *
   * Spreading *last* is a narrower claim and is pinned separately below,
   * because `enabled` does not collide with anything the harness sets: with
   * the spread moved first, every assertion in this file still passed. The
   * ordering only decides the three keys the harness supplies itself.
   */
  it("carries an option the caller passes through to the client", async () => {
    const { result } = renderHook(
      () =>
        trpc.user.admin.getAllUsers.useQuery(undefined, {
          select: (data: unknown[]) => data.length,
        }),
      { wrapper: withClient },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBe(2);
  });
});

/**
 * The measurement the whole design rests on, taken through the harness.
 *
 * A hand-written `{ isLoading: false, data: undefined }` is indistinguishable
 * from a query that has *finished*, which is the trap `HELD_QUERY_STATE`
 * exists for. Only a real client reports the three flags below, so a suite on
 * this harness can tell "held" from "ready" and one on a plain object cannot.
 */
describe("a disabled query, which is what a plain-object fake cannot express", () => {
  it("reports isLoading false with isPending true and isFetching false", () => {
    const { result } = renderHook(
      () => trpc.user.me.useQuery(undefined, { enabled: false }),
      { wrapper: withClient },
    );

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(false);
    expect(trpcSpies("user.me").queryFn).not.toHaveBeenCalled();
  });

  /**
   * The control. Without it the assertion above would hold just as well in a
   * harness where no query ever ran, and `isLoading: false` would mean nothing.
   */
  it("control: the same query enabled is loading, then ready, and fetched", async () => {
    const { result } = renderHook(
      () => trpc.user.me.useQuery(undefined, { enabled: true }),
      { wrapper: withClient },
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isPending).toBe(true);
    expect(result.current.isFetching).toBe(true);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ id: "user-1" });
    expect(trpcSpies("user.me").queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("useInfiniteQuery", () => {
  /**
   * `direction` is the key a `.strict()` tRPC input rejects on page one while
   * both a caller test and a plain-object component test pass. It only appears
   * because the fetch goes through the real client, so this is the assertion
   * that keeps the harness able to catch a `.strict()` input rejecting
   * `direction` in production when no literal-returning mock ever sent one.
   */
  it("reaches the stub with React Query's own pageParam and direction", async () => {
    const { result } = renderHook(
      () =>
        trpc.user.admin.getReports.useInfiniteQuery(
          { limit: 10 },
          { getNextPageParam: () => undefined },
        ),
      { wrapper: withClient },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data.pages).toEqual([
      { reports: [{ limit: 10 }, undefined], nextCursor: undefined },
    ]);

    const [, context] = trpcSpies("user.admin.getReports").queryFn.mock
      .calls[0];
    expect(context).toHaveProperty("direction");
    expect(context).toHaveProperty("pageParam");
  });

  /**
   * The spread-last assertion with teeth.
   *
   * `initialPageParam` is one of only three keys the harness sets itself, so
   * it is one of the few places where the *order* of the spread is observable
   * at all. Moving `...options` above it in `trpcHarness.ts` makes the
   * harness's own `undefined` win and fails this test - which is what the
   * `enabled` case could not do.
   */
  it("lets the caller's initialPageParam beat the harness default", async () => {
    const { result } = renderHook(
      () =>
        trpc.user.admin.getReports.useInfiniteQuery(
          { limit: 10 },
          {
            initialPageParam: "cursor-0",
            getNextPageParam: () => undefined,
          },
        ),
      { wrapper: withClient },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [, context] = trpcSpies("user.admin.getReports").queryFn.mock
      .calls[0];
    expect(context.pageParam).toBe("cursor-0");
  });
});

describe("useMutation", () => {
  it("fires onSuccess on the real timeline, with the stub's result", async () => {
    const onSuccess = jest.fn();
    const { result } = renderHook(
      () => trpc.user.requests.create.useMutation({ onSuccess }),
      { wrapper: withClient },
    );

    await act(async () => {
      result.current.mutate({ toUser: "user-2" });
    });

    expect(trpcSpies("user.requests.create").mutationFn).toHaveBeenCalledWith({
      toUser: "user-2",
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0][0]).toEqual({
      created: { toUser: "user-2" },
    });
  });
});

describe("useUtils", () => {
  it("mirrors the spec's paths as invalidate, refetch and cancel spies", async () => {
    const { result } = renderHook(() => trpc.useUtils(), {
      wrapper: withClient,
    });

    await act(async () => {
      await result.current.user.admin.getAllUsers.invalidate();
      await result.current.user.me.refetch();
    });

    expect(
      trpcSpies("user.admin.getAllUsers").invalidate,
    ).toHaveBeenCalledTimes(1);
    expect(trpcSpies("user.me").refetch).toHaveBeenCalledTimes(1);
    expect(typeof result.current.user.me.cancel).toBe("function");
  });

  /**
   * The default `invalidate` records and resolves - it does not reach the
   * cache - which keeps an unrelated query from refetching mid-assertion. A
   * suite that needs the real thing declares it and is handed the live
   * client.
   */
  it("runs a declared invalidate against the live client, and refetches", async () => {
    const { result } = renderHook(
      () => ({
        users: trpc.user.admin.getAllUsers.useQuery(undefined),
        utils: trpc.useUtils(),
      }),
      { wrapper: withClient },
    );

    await waitFor(() => expect(result.current.users.isSuccess).toBe(true));
    expect(trpcSpies("user.admin.getAllUsers").queryFn).toHaveBeenCalledTimes(
      1,
    );

    await act(async () => {
      await result.current.utils.user.recommendations.me.invalidate();
    });

    expect(
      trpcSpies("user.recommendations.me").invalidate,
    ).toHaveBeenCalledTimes(1);
    // Reached the cache, unlike the default: the query ran a second time.
    await waitFor(() =>
      expect(trpcSpies("user.admin.getAllUsers").queryFn).toHaveBeenCalledTimes(
        2,
      ),
    );
  });

  it("control: the default invalidate does not reach the cache", async () => {
    const { result } = renderHook(
      () => ({
        me: trpc.user.me.useQuery(undefined),
        utils: trpc.useUtils(),
      }),
      { wrapper: withClient },
    );

    await waitFor(() => expect(result.current.me.isSuccess).toBe(true));

    await act(async () => {
      await result.current.utils.user.me.invalidate();
    });

    expect(trpcSpies("user.me").queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("the inert shapes, for a procedure the suite is not about", () => {
  it("inertQuery returns a literal result and never fetches", () => {
    const { result } = renderHook(() => trpc.mapbox.search.useQuery("boston"), {
      wrapper: withClient,
    });

    expect(result.current).toEqual({ data: undefined, error: null });
    expect(trpcSpies("mapbox.search").queryFn).not.toHaveBeenCalled();
  });

  it("inertMutation exposes stable spies in a fresh object each render", () => {
    const { result, rerender } = renderHook(
      () => trpc.user.emails.sendRequestNotification.useMutation(),
      { wrapper: withClient },
    );

    const first = result.current;
    expect(first.isPending).toBe(false);

    act(() => {
      first.mutate({ to: "user-2" });
    });
    expect(
      trpcSpies("user.emails.sendRequestNotification").mutate,
    ).toHaveBeenCalledWith({ to: "user-2" });

    rerender();
    // A new object every render, as React Query itself returns - so a
    // component depending on its identity is not accidentally stabilised here.
    expect(result.current).not.toBe(first);
    expect(result.current.mutate).toBe(first.mutate);
  });
});

describe("trpcSpies and resetTrpcSpies", () => {
  /**
   * A typo must not read as "never called". Handing back fresh spies for an
   * unknown path would make every count assertion pass vacuously at zero,
   * which is the failure mode this guards.
   */
  it("throws on a path the spec never declared, naming the ones it did", () => {
    expect(() => trpcSpies("user.admin.getAllUser")).toThrow(
      /not in the mock spec/,
    );
    expect(() => trpcSpies("user.admin.getAllUser")).toThrow(
      /user\.admin\.getAllUsers/,
    );
  });

  it("clears call counts while keeping each stub's implementation", async () => {
    const first = renderHook(() => trpc.user.me.useQuery(undefined), {
      wrapper: withClient,
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(trpcSpies("user.me").queryFn).toHaveBeenCalledTimes(1);

    resetTrpcSpies();
    expect(trpcSpies("user.me").queryFn).not.toHaveBeenCalled();

    // `mockClear`, not `mockReset`: the stub still answers after a reset, so a
    // `beforeEach` does not silently turn every query's data into undefined.
    const second = renderHook(() => trpc.user.me.useQuery(undefined), {
      wrapper: withClient,
    });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(second.result.current.data).toEqual({ id: "user-1" });
  });
});
