/**
 * The three session states `buildNextAuthMock` can produce, and the wiring
 * that lets a suite reach its spies.
 *
 * `trpcHarness.test.tsx` covers the equivalent ground for the tRPC stub. The
 * other three stubs added alongside this one are pass-throughs over a literal
 * surface, and a test asserting that a one-line stub returns its own constant
 * would be noise - the exception is the one behaviour here that is not a
 * constant, which is the status-to-`data` mapping.
 *
 * The file mocks `next-auth/react` at the top, the way a real consumer does,
 * so the `require`-inside-factory form and the identity of the exported
 * `useSession` are exercised rather than described. The direct-builder cases
 * that follow re-run `buildNextAuthMock` for the other two states; that
 * replaces the module-level spy registry but *not* the object already handed
 * to Jest, so they read the builder's return value rather than the import.
 */

import { renderHook } from "@testing-library/react";
import { useSession } from "next-auth/react";
import { buildNextAuthMock, nextAuthSpies } from "./nextAuthStub";

jest.mock("next-auth/react", () =>
  require("./nextAuthStub").buildNextAuthMock({ status: "unauthenticated" }),
);

describe("buildNextAuthMock, as a consumer sees it", () => {
  it("is the module's own useSession, so an imported reference is the spy", () => {
    // WelcomeTutorial.test.tsx casts the import to a jest.Mock and drives it.
    // A wrapper delegating to a private spy would break that, and the failure
    // would be a confusing `mockReturnValue is not a function`.
    expect(jest.isMockFunction(useSession)).toBe(true);
    expect(useSession).toBe(nextAuthSpies().useSession);
  });

  it("reports the unauthenticated state it was built with", () => {
    const { result } = renderHook(() => useSession());

    expect(result.current).toMatchObject({
      data: null,
      status: "unauthenticated",
    });
  });

  it("lets a suite override the session per test", () => {
    nextAuthSpies().useSession.mockReturnValue({
      data: { user: { name: "Someone Else" } },
      status: "authenticated",
    });

    const { result } = renderHook(() => useSession());

    expect(result.current.data?.user?.name).toBe("Someone Else");
  });
});

describe("the states buildNextAuthMock can produce", () => {
  it("defaults to an authenticated session carrying the shared test user", () => {
    const mock = buildNextAuthMock();

    expect(mock.useSession()).toMatchObject({
      status: "authenticated",
      data: { user: { name: "Test User" } },
    });
  });

  it("merges the caller's user over that default", () => {
    const mock = buildNextAuthMock({ user: { id: "user-1", name: "Ada" } });

    expect(mock.useSession().data?.user).toMatchObject({
      id: "user-1",
      name: "Ada",
    });
  });

  it("carries an expiry, which every hand-rolled mock omitted", () => {
    // The gap this stub closes by construction: a component that started
    // reading `session.expires` saw a string in production and `undefined`
    // in all six suites that spelled the session out by hand.
    expect(typeof buildNextAuthMock().useSession().data?.expires).toBe(
      "string",
    );
  });

  it("reports no session when loading", () => {
    // Distinct from `unauthenticated` for the caller's purposes: MixpanelIdentity
    // must not identify anyone on either, but ComplianceGate holds the terms
    // dialog back only while loading.
    expect(buildNextAuthMock({ status: "loading" }).useSession()).toMatchObject(
      { data: null, status: "loading" },
    );
  });

  it("reports no session when unauthenticated, even if a user was named", () => {
    // A session with a user and a status of `unauthenticated` is a state
    // NextAuth never produces, so the stub refuses to fabricate it rather
    // than letting a test assert against something impossible.
    const mock = buildNextAuthMock({
      status: "unauthenticated",
      user: { name: "Ignored" },
    });

    expect(mock.useSession()).toMatchObject({
      data: null,
      status: "unauthenticated",
    });
  });

  it("hands back the same update function useSession reports", () => {
    // WelcomeTutorial destructures `update` and calls it after the tour.
    const mock = buildNextAuthMock();

    expect(mock.useSession().update).toBe(nextAuthSpies().update);
  });
});

describe("nextAuthSpies", () => {
  it("throws when the mock was never built, rather than passing vacuously", () => {
    // Guards the case the error message names: a suite that calls the
    // accessor but forgot the `jest.mock`. Proven by isolating the module
    // registry so this file's own top-level factory has not run in it.
    jest.isolateModules(() => {
      const fresh = require("./nextAuthStub");
      expect(() => fresh.nextAuthSpies()).toThrow(
        /buildNextAuthMock has not run/,
      );
    });
  });
});
