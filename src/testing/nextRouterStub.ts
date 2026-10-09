/**
 * The shared fake of `next/router`.
 *
 * As with the other stubs in this directory the win is the surface rather
 * than the line count. `useRouter()` returns a `NextRouter`, and a component
 * reading `router.query` in a mock that pins only `{ push }` gets `undefined`
 * and crashes on the first property access - so a suite that mocks the least
 * is the one most likely to fail for a reason that has nothing to do with
 * what it tests.
 *
 * ---
 *
 * **`require` inside the factory is the only call form that works** - see
 * `trpcHarness.ts` for why.
 *
 *     jest.mock("next/router", () =>
 *       require("../testing/nextRouterStub").buildRouterMock(),
 *     );
 *
 * The overrides object is evaluated while the hoisted factory runs, so it
 * carries plain data only - `pathname`, `query`, `asPath`. A locally declared
 * `const push = jest.fn()` must *not* be passed in: it is still in its
 * temporal dead zone at that point. Reach the router's own spy with
 * `routerSpies().push`, whose identity is stable for the suite.
 *
 * ---
 *
 * **`events` is pinned although nothing reads it today.** No runtime module
 * under `src/` touches `router.events` any more. It stays because the real
 * router has it, and a component that starts subscribing to route changes
 * would otherwise fail inside an effect rather than at the mock. The same
 * reasoning as `mixpanelBrowserStub.js`.
 */

export type RouterOverrides = {
  pathname?: string;
  query?: Record<string, string | string[] | undefined>;
  asPath?: string;
  isReady?: boolean;
  route?: string;
  basePath?: string;
};

export type RouterSpies = {
  push: jest.Mock;
  replace: jest.Mock;
  prefetch: jest.Mock;
  back: jest.Mock;
  forward: jest.Mock;
  reload: jest.Mock;
  beforePopState: jest.Mock;
  events: { on: jest.Mock; off: jest.Mock; emit: jest.Mock };
};

/** Populated by `buildRouterMock`; see `trpcHarness.ts` on why this is safe. */
let spies: RouterSpies | null = null;
let router: Record<string, unknown> | null = null;

/** The spies this module owns. Throws when `buildRouterMock` has not run. */
export const routerSpies = (): RouterSpies => {
  if (!spies) {
    throw new Error(
      "routerSpies: buildRouterMock has not run. Add " +
        'jest.mock("next/router", () => ' +
        'require("<path>/testing/nextRouterStub").buildRouterMock()) to this file.',
    );
  }
  return spies;
};

/**
 * The router object `useRouter()` hands back, for a suite that needs a field
 * to change between tests.
 *
 * `useRouter` returns this same object on every call, so assigning to it in a
 * `beforeEach` is visible to the next render - which is how
 * `Header.tabQuery.test.tsx` varies `query`. It did that with a getter over a
 * local `let`, which cannot survive being spread into the overrides, so the
 * mutable object is exposed instead of the getter.
 */
export const routerState = (): Record<string, unknown> => {
  if (!router) {
    throw new Error(
      "routerState: buildRouterMock has not run. Add " +
        'jest.mock("next/router", () => ' +
        'require("<path>/testing/nextRouterStub").buildRouterMock()) to this file.',
    );
  }
  return router;
};

/** Clears call records on every spy, `events` included. For `beforeEach`. */
export const resetRouterSpies = (): void => {
  if (!spies) return;
  const { events, ...rest } = spies;
  for (const spy of Object.values(rest)) spy.mockClear();
  for (const spy of Object.values(events)) spy.mockClear();
};

/**
 * Builds the module object `jest.mock("next/router")` must return.
 *
 * `push`, `replace` and `prefetch` resolve `true`, which is what the real
 * router does - a component awaiting a navigation would hang on `undefined`.
 */
export const buildRouterMock = (overrides: RouterOverrides = {}) => {
  spies = {
    push: jest.fn(async () => true),
    replace: jest.fn(async () => true),
    prefetch: jest.fn(async () => undefined),
    back: jest.fn(),
    forward: jest.fn(),
    reload: jest.fn(),
    beforePopState: jest.fn(),
    events: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
  };

  router = {
    ...spies,
    pathname: "/",
    route: "/",
    asPath: "/",
    basePath: "",
    query: {},
    isReady: true,
    isFallback: false,
    isPreview: false,
    isLocaleDomain: false,
    ...overrides,
  };

  return {
    __esModule: true,
    useRouter: () => router,
    default: router,
    withRouter: (Component: unknown) => Component,
  };
};
