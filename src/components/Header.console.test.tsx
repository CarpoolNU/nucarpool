/**
 * That rendering the mobile header logs nothing.
 *
 * `MobileNavItem` was `styled.button<{ active: boolean }>`. Under
 * styled-components v6 a prop without a `$` prefix is treated as a DOM prop and
 * forwarded to the element, so React received `active={true}` on a `<button>`,
 * declined to write it, and logged `Received `true` for a non-boolean attribute
 * `active``. Prefixing it marks the prop transient - consumed for the template,
 * never forwarded.
 *
 * ---
 *
 * **Why this is a separate file from `Header.test.tsx`, which already renders
 * at `MOBILE_WIDTH`.** React caches this warning per attribute name in a
 * module-scoped object, so it fires **once** and is then suppressed for the
 * lifetime of the module. Measured, because it decides where the test can live:
 *
 *   render 1 -> 1 warning
 *   render 2 -> 0
 *   render 3 -> 0
 *
 * Jest gives each test *file* a fresh module registry, so the warning is
 * available exactly once per file - to whichever mobile render happens first.
 * `Header.test.tsx` spends that render on its own first assertion, so a spy
 * added anywhere in it would observe an already-suppressed warning and pass
 * against the unfixed component. This file exists so the assertion is the first
 * mobile render in its registry, and so that nothing added to it later can
 * silently consume the one warning it depends on.
 *
 * That also corrects the ticket's stated impact. The bottom bar renders four
 * items, but `active={false}` does not warn at all - only the one active tab
 * passed a `true` - and the dedup means even that is once per page load rather
 * than once per render. One warning, not four per render, and not doubled by
 * StrictMode.
 *
 * **Keep this file to one rendering test.** A second one here would be
 * asserting against a suppressed warning and would pass regardless.
 */

import { render, screen } from "@testing-library/react";
import { Role, Status } from "@prisma/client";
import Header from "./Header";
import { UserContext } from "../utils/userContext";
import { User } from "../utils/types";
import {
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";

/*
 * The same mocks `Header.test.tsx` uses, and for the same reasons - `Header`
 * reaches a router, four tRPC queries, a Pusher subscription and next-auth.
 * Duplicated rather than shared: a helper importing them would have to be a
 * module, and `jest.mock` is hoisted per file, so the factories cannot be
 * lifted out without also lifting the hoisting. The subject here is narrow
 * enough that the copies are cheap.
 */
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    pathname: "/",
    query: {},
  }),
}));

jest.mock("../utils/trpc", () => ({
  trpc: {
    user: {
      messages: {
        getUnreadMessageCount: { useQuery: () => ({ data: undefined }) },
      },
      groups: { me: { useQuery: () => ({ data: undefined }) } },
      me: { useQuery: () => ({ data: undefined }) },
      getPresignedDownloadUrl: {
        useQuery: () => ({ data: undefined, error: null, isLoading: false }),
      },
    },
  },
}));

jest.mock("../utils/messages/useUnreadNotifications", () => ({
  useUnreadNotifications: () => undefined,
}));

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signOut: jest.fn(),
}));

restoreViewportAfterEach();

const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  preferredName: "Sam",
} as unknown as User;

it("renders the mobile navigation without logging a React warning", () => {
  setViewportWidth(MOBILE_WIDTH);

  /*
   * Not mocked away - the calls are collected so a failure can print what was
   * actually logged, and an unexpected warning is as interesting as the one
   * being guarded.
   */
  const consoleError = jest.spyOn(console, "error").mockImplementation();

  try {
    render(
      <UserContext.Provider value={VIEWER}>
        <Header
          data={{
            sidebarValue: "explore",
            setSidebar: () => undefined,
            disabled: false,
          }}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>,
    );

    // The bar really did render, so the assertion below is about a tree that
    // contains the four `MobileNavItem`s rather than an early return.
    expect(screen.getByTestId("navigation")).toBeInTheDocument();

    /*
     * Formatted through `util.format`-style substitution, so the attribute
     * name arrives as a separate argument rather than inside the template.
     * Stringifying the whole call is what makes the match independent of
     * which argument React puts it in.
     */
    const logged = consoleError.mock.calls.map((call) => JSON.stringify(call));

    expect(
      logged.filter((call) => call.includes("non-boolean attribute")),
    ).toEqual([]);

    // Nothing else either. `Header` is the app's most-rendered component and a
    // clean console here is worth more than a clean one for this attribute.
    expect(logged).toEqual([]);
  } finally {
    consoleError.mockRestore();
  }
});
