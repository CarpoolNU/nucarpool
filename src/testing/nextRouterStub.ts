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
 * **`events` is a working emitter, not three inert spies.** It was pinned as
 * bare `jest.fn()`s for a long time, against the day something subscribed to
 * route changes - which `useUnsavedChangesGuard` now does. Spies alone record
 * the subscription and can never deliver to it, so a test could assert that
 * the page listened and never that listening did anything. `on` and `off`
 * maintain a real registry and `emit` calls it, while all three stay
 * `jest.Mock`s so existing call assertions are unaffected.
 *
 * The registry is an **array per event name rather than a Set**: a handler
 * registered twice has to show up twice, because the leak an effect with the
 * wrong dependencies produces is exactly a second live subscription, and a Set
 * would silently absorb it.
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

/** The live subscriptions `events.on` has added and `events.off` not removed. */
type EventHandler = (...args: unknown[]) => void;
let handlers: Map<string, EventHandler[]> = new Map();

/**
 * The handlers currently registered for an event, for a test that needs to
 * assert a subscription was torn down.
 *
 * `routeHandlers("routeChangeStart")` returning an empty array after unmount
 * is the check; a length of two is the duplicate-subscription leak the array
 * registry exists to expose.
 */
export const routeHandlers = (event: string): EventHandler[] => [
  ...(handlers.get(event) ?? []),
];

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

/**
 * Clears call records on every spy, `events` included. For `beforeEach`.
 *
 * The event registry is emptied as well. `mockClear` keeps an implementation
 * and only drops recorded calls, so without this the handlers a previous test
 * subscribed would stay live and receive the next test's `emit` - the same
 * cross-test bleed `headlessui-transition` act warnings come from, and just as
 * hard to read, because the failure names whichever test emitted rather than
 * the one that leaked.
 */
export const resetRouterSpies = (): void => {
  handlers = new Map();
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
  handlers = new Map();
  spies = {
    push: jest.fn(async () => true),
    replace: jest.fn(async () => true),
    prefetch: jest.fn(async () => undefined),
    back: jest.fn(),
    forward: jest.fn(),
    reload: jest.fn(),
    beforePopState: jest.fn(),
    events: {
      on: jest.fn((event: string, handler: EventHandler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      }),
      off: jest.fn((event: string, handler: EventHandler) => {
        const remaining = (handlers.get(event) ?? []).filter(
          (candidate) => candidate !== handler,
        );
        handlers.set(event, remaining);
      }),
      // Iterates a copy, because the real emitter tolerates a handler that
      // unsubscribes itself and a live array would skip the next one.
      //
      // Deliberately **not** try/catch: `routeChangeStart` is emitted outside
      // Next's own try block (`router.js:844`), so a listener that throws
      // rejects `router.push`. That is the whole mechanism
      // `useUnsavedChangesGuard` aborts a navigation with, and swallowing it
      // here would make the abort untestable.
      emit: jest.fn((event: string, ...args: unknown[]) => {
        for (const handler of [...(handlers.get(event) ?? [])]) {
          handler(...args);
        }
      }),
    },
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
