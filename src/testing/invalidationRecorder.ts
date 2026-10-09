/**
 * A stand-in for `trpc.useUtils()` that **records** which caches a handler
 * invalidated, instead of declaring which ones it is allowed to.
 *
 * The distinction is the whole point. The usual fake is a literal tree:
 *
 *     useUtils.mockReturnValue({
 *       user: { me: { invalidate: jest.fn() }, groups: { me: { … } } },
 *     });
 *
 * which encodes the *current* set in the fixture. A handler that invalidates
 * one cache too few still passes, because nothing asserts the set; and a
 * handler that invalidates one more throws `Cannot read properties of
 * undefined` from inside `onSuccess` rather than failing an assertion that
 * names the missing cache. A missing invalidation can therefore go unnoticed
 * by a suite that otherwise covers the very handler carrying it.
 *
 * Here the tree is a `Proxy` that materialises any path on access, so the
 * fixture states nothing and the assertion states everything:
 *
 *     expect(recorder.calls).toEqual(["user.me.invalidate", …]);
 *
 * Paths are recorded as `dotted.procedure.path` plus the method, so switching
 * an `invalidate` to a `refetch` reads as a change rather than silently
 * matching - the two are not interchangeable here, since `refetch` runs even
 * for an inactive query and `invalidate` does not.
 *
 * **It records, it does not act.** Every method resolves and reaches no cache,
 * which is what keeps an unrelated query from refetching mid-assertion. A test
 * whose claim is "the query refetched" needs a real `QueryClient` instead -
 * see `membershipDiscoveryRefetch.test.tsx`, built on `trpcHarness`.
 */

// Type-only, so nothing is required at runtime. A value import would re-enter
// the consumer's own hoisted `jest.mock` of `utils/trpc`.
import type { trpc } from "../utils/trpc";

type Utils = ReturnType<typeof trpc.useUtils>;

/**
 * The leaves. Anything else is treated as another step along the path, which
 * is what lets the proxy serve a procedure tree it was never told about.
 */
const RECORDED_METHODS = new Set(["invalidate", "refetch", "cancel", "reset"]);

export type InvalidationRecorder = {
  /** Passes where the real `trpc.useUtils()` return value would. */
  utils: Utils;
  /** Every call, in order, as `dotted.path.method`. Duplicates included. */
  calls: string[];
  /** The same, de-duplicated and sorted - for an assertion on the set alone. */
  paths: () => string[];
  reset: () => void;
};

export const recordInvalidations = (): InvalidationRecorder => {
  const calls: string[] = [];

  const node = (path: string): unknown =>
    new Proxy(Object.create(null) as Record<string, unknown>, {
      get: (_target, key) => {
        // A symbol key is never a procedure name: it is jest, `expect` or the
        // console inspecting the object (`Symbol.toPrimitive`, `util.inspect`).
        // Walking it would record a path nobody asked for.
        if (typeof key !== "string") {
          return undefined;
        }
        if (RECORDED_METHODS.has(key)) {
          return async () => {
            calls.push(`${path}.${key}`);
          };
        }
        return node(path ? `${path}.${key}` : key);
      },
    });

  return {
    utils: node("") as Utils,
    calls,
    paths: () => [...new Set(calls)].sort(),
    reset: () => {
      calls.length = 0;
    },
  };
};
