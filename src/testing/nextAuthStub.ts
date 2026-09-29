/**
 * The shared fake of `next-auth/react`.
 *
 * Fourteen test files mock this module, in five shapes that differ only in
 * which session they hand back: six return `{ data: { user: { name: "Test
 * User" } } }`, three return an unauthenticated session, two expose a local
 * `jest.fn()` so the suite can vary it per test, and two mock `signOut` alone.
 * None of them is wrong; the point of collapsing them is that the *sixth*
 * shape a new test needs should not be invented from whichever neighbour the
 * author happened to open.
 *
 * ---
 *
 * **`require` inside the factory is the only call form that works**, for the
 * reason `trpcHarness.ts` sets out at length: `jest.mock` factories are
 * hoisted above the file's imports, so a top-level
 * `import { buildNextAuthMock }` fails with *"The module factory of
 * `jest.mock()` is not allowed to reference any out-of-scope variables"*.
 *
 *     jest.mock("next-auth/react", () =>
 *       require("../testing/nextAuthStub").buildNextAuthMock(),
 *     );
 *
 * For the same reason the options object must not read a `const` declared
 * later in the test file: unlike a stub *body*, which does not run until
 * render, the options are evaluated while the factory runs and a later `const`
 * is still in its temporal dead zone. Vary the session with
 * `nextAuthSpies().useSession.mockReturnValue(...)` instead, which is what the
 * two dynamic files already did by hand.
 *
 * ---
 *
 * **`useSession` is itself the `jest.Mock`**, rather than a wrapper delegating
 * to one. That keeps both existing idioms working unchanged: a suite may
 * reach it through `nextAuthSpies()`, or it may `import { useSession } from
 * "next-auth/react"` and cast - which is what `WelcomeTutorial.test.tsx`
 * does. A wrapper would have broken the second.
 *
 * The default implementation is the one passed to `jest.fn(impl)`, so it
 * survives `jest.clearAllMocks()` in a `beforeEach` - that clears call
 * records, it does not remove implementations. `jest.resetAllMocks()` would
 * remove it, and no file in the cohort calls that.
 *
 * ---
 *
 * **Why the surface is wider than the cohort needs.** `signIn`, `getSession`
 * and `SessionProvider` are pinned here although no file in the cohort
 * reaches them. `mixpanelBrowserStub.js` records the failure this prevents:
 * a mock that covers only today's callers turns tomorrow's new component into
 * `signIn is not a function` thrown from inside an effect, which reads like a
 * broken component rather than like a stub that was never updated.
 *
 * `SessionProvider` is built with `createElement` rather than JSX so this file
 * stays `.ts`, matching `trpcHarness.ts` and the rest of `src/testing/`.
 */

import { createElement, type ReactNode } from "react";

/** The session states NextAuth's `useSession` can report. */
export type SessionStatus = "authenticated" | "unauthenticated" | "loading";

/**
 * The user fields the app actually reads off a session.
 *
 * `next-auth.d.ts` widens `session.user` with `id`; `name`, `email` and
 * `image` are NextAuth's own. Left open so a suite can pin a field this list
 * does not name without a cast.
 */
export type StubSessionUser = {
  id?: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  [key: string]: unknown;
};

export type NextAuthMockOptions = {
  /** Defaults to `"authenticated"`. */
  status?: SessionStatus;
  /**
   * Merged over the default user. Ignored unless `status` is
   * `"authenticated"`, because a session with a user but a status of
   * `"unauthenticated"` is a state NextAuth never produces and would let a
   * test assert against something that cannot happen.
   */
  user?: StubSessionUser;
};

/**
 * The name six of the fourteen files already used. Kept as the default so
 * those migrations are a pure deletion rather than a behaviour change.
 */
const DEFAULT_USER: StubSessionUser = { name: "Test User" };

/**
 * Far enough out that a component comparing it against `Date.now()` treats the
 * session as live. Real sessions always carry this; the hand-rolled mocks
 * omitted it, so a component that started reading it would have seen
 * `undefined` in every test and a string in production.
 */
const FAR_FUTURE_EXPIRY = "2999-01-01T00:00:00.000Z";

export type NextAuthSpies = {
  useSession: jest.Mock;
  signOut: jest.Mock;
  signIn: jest.Mock;
  getSession: jest.Mock;
  /** The `update` handed back by `useSession()`, which `WelcomeTutorial` calls. */
  update: jest.Mock;
};

/**
 * Populated by `buildNextAuthMock`, read by `nextAuthSpies`.
 *
 * Module-level state is safe for the reason `trpcHarness.ts` gives: Jest hands
 * every suite its own module registry, so two test files never share this -
 * and within one suite the factory's `require` and a top-level `import` of
 * this file resolve to the same instance, which is what lets a test reach the
 * spies the factory created.
 */
let spies: NextAuthSpies | null = null;

/**
 * The spies this module owns.
 *
 * Throws when `buildNextAuthMock` has not run, rather than handing back a
 * fresh set of never-called spies - an assertion against a suite that forgot
 * the `jest.mock` would otherwise pass vacuously at zero calls.
 */
export const nextAuthSpies = (): NextAuthSpies => {
  if (!spies) {
    throw new Error(
      "nextAuthSpies: buildNextAuthMock has not run. Add " +
        'jest.mock("next-auth/react", () => ' +
        'require("<path>/testing/nextAuthStub").buildNextAuthMock()) to this file.',
    );
  }
  return spies;
};

/** Clears call records on every spy, leaving implementations. For `beforeEach`. */
export const resetNextAuthSpies = (): void => {
  if (!spies) return;
  for (const spy of Object.values(spies)) spy.mockClear();
};

/** Builds the module object `jest.mock("next-auth/react")` must return. */
export const buildNextAuthMock = (options: NextAuthMockOptions = {}) => {
  const status = options.status ?? "authenticated";

  const update = jest.fn(async () => null);

  const data =
    status === "authenticated"
      ? {
          user: { ...DEFAULT_USER, ...options.user },
          expires: FAR_FUTURE_EXPIRY,
        }
      : null;

  const useSession = jest.fn(() => ({ data, status, update }));

  spies = {
    useSession,
    signOut: jest.fn(async () => undefined),
    signIn: jest.fn(async () => undefined),
    getSession: jest.fn(async () => data),
    update,
  };

  return {
    __esModule: true,
    useSession,
    signOut: spies.signOut,
    signIn: spies.signIn,
    getSession: spies.getSession,
    SessionProvider: ({ children }: { children?: ReactNode }) =>
      createElement("div", { "data-testid": "session-provider" }, children),
  };
};
