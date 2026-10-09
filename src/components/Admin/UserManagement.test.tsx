/**
 * `UserManagement`: what a discarded hydration pass costs, and what a failed
 * `getAllUsers` shows.
 *
 * Two tickets, one per `describe` block, which were two sibling files until the
 * setup they shared outgrew the reason for the split - both mock the same two
 * procedures through `trpcHarness`, render the same component inside the same
 * client, and drive the same viewport helpers. Neither of the mandatory split
 * reasons in `CLAUDE.md` applied. The one thing that had to be reconciled is
 * `getAllUsers`, which resolved to a fixed empty list in one file and to a
 * per-test `behaviour` in the other; `behaviour` covers both, defaulting to the
 * empty list the hydration block expects.
 *
 * ---
 *
 * That the hydration pass `/admin` cannot avoid does not cost a `getAllUsers`.
 *
 * `/admin` is the one page whose `Header` and dashboard are genuinely in the
 * server HTML, because `userPermission` arrives from `getServerSideProps`
 * rather than from a query behind `ssr: false`. React reads `useIsMobile`'s
 * `getServerSnapshot` - hardcoded `false` - during hydration as well as on the
 * server, so on a phone that pass renders the *desktop* dashboard, mounting
 * `UserManagement` and its query, before `AdminMobileNotice` replaces it.
 * `AdminPage.test.tsx` pins that shape deliberately; this file is about what it
 * costs.
 *
 * **The gate is `isHydrated` alone, with no viewport term, and that is forced
 * rather than chosen.** On the pass in question `useIsMobile` reports `false`
 * - that *is* the defect - so "is this a phone" is not answerable at render
 * time, and the only computable condition is "might this render be thrown
 * away". So desktop is deferred by one render pass too. The second test is
 * what holds that to a deferral rather than a cancellation.
 *
 * **Why `trpc` is mocked onto a real React Query rather than onto a spy.** A
 * render-time `jest.fn()` fires on the discarded pass whether or not the query
 * is disabled, so it would report one call before and after the fix and could
 * not tell the two apart. What had to be established is that the *fetch* went
 * out: React Query's observer subscribes in a passive effect, and whether that
 * runs before or after React's corrective re-render is a fact about React, not
 * about this repo. `useQuery` here is therefore the real one, fetched through a
 * spy `queryFn` - which is what tRPC's `useQuery` reduces to anyway - so the
 * counts below are measurements. Same reasoning, and the same shape, as
 * `utils/useProfileImage.test.tsx`.
 *
 * Measured against the pre-fix component, the mobile case reported **1**.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Permission } from "@prisma/client";
import UserManagement from "./UserManagement";
import useIsHydrated from "../../utils/useIsHydrated";
import useIsMobile from "../../utils/useIsMobile";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";
import { trpcSpies, resetTrpcSpies } from "../../testing/trpcHarness";

/**
 * `trpc` on a real React Query, through the shared harness. The harness
 * spreads each caller's `options` into the client, which is what carries
 * `enabled` through - so a fix that computed the gate but failed to pass it
 * shows up here as a fetch that still happens.
 *
 * `updateUserPermission` is inert and `useUtils` comes from the harness: the
 * component calls both during render and neither is the subject.
 */
jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.admin.getAllUsers": { query: () => behaviour() },
    "user.admin.updateUserPermission": { inertMutation: true },
  }),
);

/** The `getAllUsers` fetch, counted from inside the client. */
const queryFn = () => trpcSpies("user.admin.getAllUsers").queryFn;

/**
 * What the one fetch does, set per test. The default is the resolving empty
 * list the hydration block below wants; the failure block overrides it.
 */
let behaviour: () => Promise<unknown[]> = async () => [];

restoreViewportAfterEach();

const ADMIN_USER = {
  id: "u1",
  email: "someone@northeastern.edu",
  permission: "USER",
};

const renderTab = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UserManagement permission={Permission.MANAGER} />
    </QueryClientProvider>,
  );

/** The spinner is `Spinner`'s own text, which is all it renders as words. */
const spinner = () => screen.queryByText("Loading...");

beforeEach(() => {
  setViewportWidth(DESKTOP_WIDTH);
  resetTrpcSpies();
  behaviour = async () => [];
});

/**
 * `admin.tsx`'s conditional, reproduced rather than imported.
 *
 * The page itself pulls `AdminData` behind it - four chart components, antd and
 * JSZip - none of which bears on which subtree the hydration pass mounts, and
 * `AdminPage.test.tsx` already pins the real page's branch with its children
 * mocked to markers. What this file needs from the page is only its shape: the
 * dashboard on the pass that could be hydration, the notice on every pass
 * after it at a phone width.
 */
const AdminDashboardBranch = () => {
  // Both read unconditionally, as the page reads them. Folding these into one
  // `useIsHydrated() && useIsMobile()` expression short-circuits away the
  // second hook on the hydration pass - the exact pass this file is about -
  // and React fails the next render with "rendered more hooks than during the
  // previous render".
  const isHydrated = useIsHydrated();
  const isMobile = useIsMobile();

  return isHydrated && isMobile ? (
    <div>mobile notice</div>
  ) : (
    <UserManagement permission={Permission.MANAGER} />
  );
};

const withClient = (node: React.ReactNode) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {node}
  </QueryClientProvider>
);

/**
 * Serves a server render into a container and hydrates it, the way a real page
 * load of `/admin` does.
 *
 * The `renderToString` output is handed back too, so a caller can pin what the
 * server actually emitted rather than only what hydration settled on.
 */
const hydrated: { root: Root; container: HTMLElement }[] = [];

afterEach(() => {
  for (const { root, container } of hydrated.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const hydrateAt = async (width: number) => {
  setViewportWidth(width);
  resetTrpcSpies();

  const tree = withClient(<AdminDashboardBranch />);
  const serverHtml = renderToString(tree);

  const container = document.createElement("div");
  /*
   * `hydrateRoot` needs real DOM to reconcile against, and this markup is
   * `renderToString`'s own output for a tree defined in this file - not a
   * stored value, a user-authored field or anything else the lint rule exists
   * to stop. Same disable, for the same reason, as `AdminPage.test.tsx` and
   * `utils/useProfileImage.test.tsx`.
   */
  // eslint-disable-next-line no-restricted-syntax
  container.innerHTML = serverHtml;
  document.body.appendChild(container);

  const consoleError = jest.spyOn(console, "error").mockImplementation();
  try {
    await act(async () => {
      hydrated.push({ root: hydrateRoot(container, tree), container });
    });
  } finally {
    consoleError.mockRestore();
  }

  return { serverHtml, text: container.textContent ?? "" };
};

describe("UserManagement on a hydration pass that is discarded", () => {
  it("fires no getAllUsers when the mobile notice replaces the dashboard", async () => {
    const { serverHtml, text } = await hydrateAt(MOBILE_WIDTH);

    // The server had to guess the viewport and guessed desktop, so
    // `UserManagement` really is in the HTML being hydrated - its own spinner,
    // which is all it renders until `users` arrives. Without this the test
    // could pass by the component never being involved at all.
    expect(serverHtml).toContain("Loading...");

    // ...and the client corrected to the notice, discarding it.
    expect(text).toContain("mobile notice");

    // Without the deferral, that discarded mount would cost one privileged
    // request for the entire user table, on every mobile load of `/admin`.
    expect(queryFn()).not.toHaveBeenCalled();
  });

  it("still fetches when the dashboard survives hydration", async () => {
    await hydrateAt(DESKTOP_WIDTH);

    // The other side, so a component that simply never fetched would fail
    // here. The gate is one render pass of deferral, not a cancellation - and
    // because it carries no viewport term, desktop pays that pass too.
    expect(queryFn()).toHaveBeenCalledTimes(1);
  });
});

describe("UserManagement on a fresh client mount", () => {
  it("starts its request on the first render, undeferred", async () => {
    setViewportWidth(DESKTOP_WIDTH);
    resetTrpcSpies();

    await act(async () => {
      render(withClient(<UserManagement permission={Permission.MANAGER} />));
    });

    /*
     * `useIsHydrated` reports `true` immediately on a mount that is not
     * hydration, which is the property that makes the gate above cost nothing
     * anywhere else. A `useState(false)` plus mount effect would defer this
     * one too and fail here.
     */
    expect(queryFn()).toHaveBeenCalledTimes(1);
  });
});

/**
 * Covers that a failed `getAllUsers` says so, and offers a way out.
 *
 * The Permissions tab is `/admin`'s default. If its loading state lived in a
 * `useState<boolean>(true)` cleared only by an effect watching `users`,
 * nothing else could clear it, so a failure would be a spinner that spins
 * for the rest of the session - and `adminRouter` throws `UNAUTHORIZED` for
 * `permission === "USER"`, which a MANAGER can cause by demoting someone out
 * from under their own live session. Any 500 would land the same way.
 *
 * **`trpc` is mocked onto a real React Query with a rejecting `queryFn`, not
 * onto a stub reporting `isError: true`.** A stub would assert that the
 * component renders `QueryError` when told it failed, which is the easy half.
 * What has to hold is that React Query *reports* a rejected fetch the way the
 * component reads it, and - for the retry - that refetching a failed query
 * really does recover the view. Neither is observable through a hand-written
 * flag. Same reasoning, and the same shape, as the
 * hydration block above.
 *
 * `retry: false` on the client so one rejection is one error rather than four
 * attempts; the app's own policy in `utils/trpc.ts` already declines to retry
 * the `UNAUTHORIZED` and `NOT_FOUND` cases this stands in for.
 */
describe("UserManagement when getAllUsers fails", () => {
  it("renders the error treatment and drops the spinner", async () => {
    behaviour = async () => {
      throw new Error("UNAUTHORIZED");
    };

    renderTab();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not load the user list.");

    // Without this, a failure would leave the spinner there, forever.
    expect(spinner()).not.toBeInTheDocument();
  });

  it("recovers when retry is pressed and the cause has cleared", async () => {
    behaviour = async () => {
      throw new Error("boom");
    };

    renderTab();
    await screen.findByRole("alert");

    // The underlying cause clears - a session refreshed, a 500 that passed.
    behaviour = async () => [ADMIN_USER];

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });

    await waitFor(() =>
      expect(screen.getByText("Permissions Management")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(queryFn()).toHaveBeenCalledTimes(2);
  });

  /**
   * The control, and the mutation test for the case above. A component that
   * rendered `QueryError` unconditionally would pass both error assertions and
   * fail here.
   */
  it("control: a resolving query renders the list and no error", async () => {
    behaviour = async () => [ADMIN_USER];

    renderTab();

    await waitFor(() =>
      expect(screen.getByText("Permissions Management")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(spinner()).not.toBeInTheDocument();
  });

  /**
   * The third state, loading. Kept here so "spinner while loading" and
   * "error once failed" are pinned against the same component rather than
   * only the second being asserted.
   */
  it("control: shows the spinner while the fetch is still in flight", () => {
    behaviour = () => new Promise(() => undefined);

    renderTab();

    expect(spinner()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
