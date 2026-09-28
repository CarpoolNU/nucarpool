/**
 * The shared fake of `src/utils/trpc`, built on a **real** React Query client.
 *
 * Forty test files hand-roll a mock of `utils/trpc`. Fifteen of them already
 * delegate to `jest.requireActual("@tanstack/react-query")` rather than
 * returning a literal result object, because a literal cannot reproduce React
 * Query's state machine and so cannot distinguish the cases that matter:
 *
 *  - A **disabled** query reports `isLoading: false`, which a hand-written
 *    `{ isLoading: false, data }` makes indistinguishable from *ready*. That
 *    trap is why `HELD_QUERY_STATE` exists in `src/utils/queryState.ts`.
 *  - `useInfiniteQuery` always sends a `direction` key, so a `.strict()` tRPC
 *    input rejects page one in production while a literal-returning mock of
 *    the same call passes.
 *
 * Those fifteen each rebuilt the same wiring, so the pattern was copied rather
 * than shared and had begun to drift between copies. This is that wiring,
 * extracted once. `src/components/Admin/UserManagement.test.tsx` documents the
 * reasoning in place and is the file the shape was taken from.
 *
 * ---
 *
 * **`require` inside the factory is the only call form that works.**
 *
 *     jest.mock("../../utils/trpc", () =>
 *       require("../../testing/trpcHarness").buildTrpcMock({
 *         "user.admin.getAllUsers": { query: () => [] },
 *         "user.admin.updateUserPermission": { inertMutation: true },
 *       }),
 *     );
 *
 * `jest.mock` factories are hoisted above the file's imports, so a top-level
 * `import { buildTrpcMock }` fails with *"The module factory of `jest.mock()`
 * is not allowed to reference any out-of-scope variables"*. A `require`
 * evaluated when the factory runs does not.
 *
 * A stub **may** close over a `const` declared later in the test file, which
 * is how a suite varies behaviour between cases. The factory runs while the
 * component under test is being imported - before those `const`s initialise -
 * so the reference is only safe because a stub body is not called until
 * render. Reading such a variable in the spec object itself, rather than
 * inside a stub, hits the temporal dead zone.
 *
 * ---
 *
 * **What is deliberately *not* faithful.** `useUtils()` hands back spies that
 * record and do nothing. Real `invalidate` reaches the cache and refetches;
 * here it resolves. That is what the fifteen files did before this module and
 * is what keeps an unrelated query from refetching mid-assertion. A suite that
 * needs the real thing declares `invalidate` on the stub and gets the live
 * `QueryClient` handed to it.
 */

import type { QueryClient } from "@tanstack/react-query";

/**
 * The argument React Query hands a `queryFn`: `queryKey`, `signal`, and - for
 * an infinite query - `pageParam` and `direction`. Passed through to the stub
 * untouched so a test can assert on what the real client sends, which is the
 * point of `direction` reaching a `.strict()` input.
 */
export type QueryFnContext = {
  queryKey: readonly unknown[];
  signal?: AbortSignal;
  pageParam?: unknown;
  direction?: unknown;
  [key: string]: unknown;
};

export type ProcedureStub = {
  /** Real `useQuery`. The return value resolves as the query's data. */
  query?: (input: any, context: QueryFnContext) => unknown;
  /** Real `useInfiniteQuery`. Receives `pageParam` and `direction` in `context`. */
  infiniteQuery?: (input: any, context: QueryFnContext) => unknown;
  /** Real `useMutation`, so `onSuccess`/`onError` fire on React Query's timeline. */
  mutation?: (variables: any) => unknown;
  /**
   * A literal query result, for a procedure the component calls but the suite
   * is not about. No fetch, no state machine. Defaults to
   * `{ data: undefined, error: null }`.
   */
  inertQuery?: boolean | (() => unknown);
  /**
   * A literal mutation result - `{ mutate, mutateAsync, isPending: false }` -
   * for a mutation the component wires up but never fires under test.
   */
  inertMutation?: boolean;
  /** Replaces this path's `useUtils().…invalidate`, given the live client. */
  invalidate?: (queryClient: QueryClient) => unknown;
  /** Replaces this path's `useUtils().…refetch`, given the live client. */
  refetch?: (queryClient: QueryClient) => unknown;
};

export type TrpcMockSpec = Record<string, ProcedureStub>;

/**
 * Every spy this module owns for one procedure path.
 *
 * `queryFn` and `mutationFn` count what React Query actually *ran*, not what
 * the component rendered - a render-time `jest.fn()` fires on a discarded
 * pass whether or not the query is disabled, and so cannot tell a gated query
 * from an ungated one. These fire from inside the client.
 */
export type ProcedureSpies = {
  queryFn: jest.Mock;
  mutationFn: jest.Mock;
  mutate: jest.Mock;
  mutateAsync: jest.Mock;
  invalidate: jest.Mock;
  refetch: jest.Mock;
  cancel: jest.Mock;
};

/**
 * Populated by `buildTrpcMock`, read by `trpcSpies`.
 *
 * Module-level state is safe here because Jest gives every suite its own
 * module registry, so two test files never share this map - and within one
 * suite the `require` in the `jest.mock` factory and a top-level `import` of
 * this file resolve to the same instance, which is what lets a test reach the
 * spies the factory created.
 */
const registry = new Map<string, ProcedureSpies>();

const newSpies = (): ProcedureSpies => ({
  queryFn: jest.fn(),
  mutationFn: jest.fn(),
  mutate: jest.fn(),
  mutateAsync: jest.fn(async () => undefined),
  invalidate: jest.fn(async () => undefined),
  refetch: jest.fn(async () => undefined),
  cancel: jest.fn(async () => undefined),
});

const spiesFor = (path: string): ProcedureSpies => {
  const existing = registry.get(path);
  if (existing) return existing;
  const created = newSpies();
  registry.set(path, created);
  return created;
};

/**
 * The spies for one dotted procedure path.
 *
 * Throws on a path the spec did not declare, rather than handing back a fresh
 * set of never-called spies - an assertion against a typo would otherwise pass
 * vacuously at zero calls.
 */
export const trpcSpies = (path: string): ProcedureSpies => {
  const spies = registry.get(path);
  if (!spies) {
    const known = [...registry.keys()].sort().join(", ") || "(none)";
    throw new Error(
      `trpcSpies: "${path}" is not in the mock spec. Declared paths: ${known}`,
    );
  }
  return spies;
};

/** Clears call records on every registered spy. For `beforeEach`. */
export const resetTrpcSpies = (): void => {
  for (const spies of registry.values()) {
    for (const spy of Object.values(spies)) spy.mockClear();
  }
};

/** Writes `value` at a dotted path inside `root`, creating objects on the way. */
const assignAtPath = (
  root: Record<string, any>,
  path: string,
  value: unknown,
): void => {
  const segments = path.split(".");
  const leaf = segments.pop() as string;
  let node = root;
  for (const segment of segments) {
    if (node[segment] === undefined) node[segment] = {};
    node = node[segment];
  }
  node[leaf] = { ...(node[leaf] ?? {}), ...(value as object) };
};

/**
 * Builds the module object `jest.mock("…/utils/trpc")` must return.
 *
 * `extraExports` covers the module's other named exports - three suites need
 * `realTimeQueryOptions`, which their component spreads into a query's
 * options.
 */
export const buildTrpcMock = (
  spec: TrpcMockSpec,
  extraExports: Record<string, unknown> = {},
) => {
  // Required lazily, and by `requireActual`, for the same reason the caller's
  // `require` of this file is lazy: this runs inside a hoisted factory.
  const reactQuery = jest.requireActual("@tanstack/react-query");

  const trpc: Record<string, any> = {};

  for (const [path, stub] of Object.entries(spec)) {
    const spies = spiesFor(path);
    const hooks: Record<string, unknown> = {};

    if (stub.query) {
      const run = stub.query;
      spies.queryFn.mockImplementation(
        (input: unknown, context: QueryFnContext) => run(input, context),
      );
      hooks.useQuery = (input: unknown, options?: object) =>
        reactQuery.useQuery({
          queryKey: [path, input],
          queryFn: (context: QueryFnContext) => spies.queryFn(input, context),
          // Spread at all, and spread last. *That* it is spread is what
          // carries a caller's `enabled` to the client, so a fix computing a
          // gate but failing to pass it surfaces as a fetch that still
          // happens. *Last* is the narrower point and covers only the three
          // keys set above: a caller overriding `queryKey`, `queryFn` or
          // `initialPageParam` must win over this default, not lose to it.
          ...options,
        });
    }

    if (stub.infiniteQuery) {
      const run = stub.infiniteQuery;
      spies.queryFn.mockImplementation(
        (input: unknown, context: QueryFnContext) => run(input, context),
      );
      hooks.useInfiniteQuery = (input: unknown, options?: object) =>
        reactQuery.useInfiniteQuery({
          queryKey: [path, input],
          queryFn: (context: QueryFnContext) => spies.queryFn(input, context),
          initialPageParam: undefined,
          ...options,
        });
    }

    if (stub.mutation) {
      const run = stub.mutation;
      spies.mutationFn.mockImplementation((variables: unknown) =>
        run(variables),
      );
      hooks.useMutation = (options?: object) =>
        reactQuery.useMutation({
          mutationFn: (variables: unknown) => spies.mutationFn(variables),
          ...options,
        });
    }

    if (stub.inertQuery) {
      const result =
        typeof stub.inertQuery === "function"
          ? stub.inertQuery
          : () => ({ data: undefined, error: null });
      hooks.useQuery = () => result();
    }

    if (stub.inertMutation) {
      // A fresh object per call, with stable spies inside it - which is what
      // real React Query returns. The object identity changing every render is
      // load-bearing: a component that puts the whole result in a dependency
      // array is relying on something that is never stable in production.
      hooks.useMutation = () => ({
        mutate: spies.mutate,
        mutateAsync: spies.mutateAsync,
        isPending: false,
      });
    }

    assignAtPath(trpc, path, hooks);
  }

  /**
   * `trpc.useUtils()`, mirroring the spec's paths.
   *
   * `useQueryClient` is called unconditionally, as real `useUtils` does, so a
   * component reaching for utils outside a `QueryClientProvider` fails here
   * the way it would in the app rather than silently working.
   */
  const useUtils = () => {
    const queryClient = reactQuery.useQueryClient();
    const utils: Record<string, any> = {};

    for (const [path, stub] of Object.entries(spec)) {
      const spies = spiesFor(path);
      const { invalidate, refetch } = stub;
      // Wrapped rather than replaced, so a suite supplying its own behaviour
      // still gets the call recorded on the same spy it would otherwise read.
      spies.invalidate.mockImplementation(
        invalidate ? () => invalidate(queryClient) : async () => undefined,
      );
      spies.refetch.mockImplementation(
        refetch ? () => refetch(queryClient) : async () => undefined,
      );
      assignAtPath(utils, path, {
        invalidate: spies.invalidate,
        refetch: spies.refetch,
        cancel: spies.cancel,
      });
    }

    return utils;
  };

  return { trpc: { ...trpc, useUtils }, ...extraExports };
};
