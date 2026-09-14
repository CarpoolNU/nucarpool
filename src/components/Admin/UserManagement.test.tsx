/**
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

import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
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

const queryFn = jest.fn(async () => [] as unknown[]);

/**
 * `trpc.user.admin.getAllUsers.useQuery`, as the React Query call it compiles
 * down to. The `options` spread is what carries `enabled` through, so a fix
 * that computed the gate but failed to pass it would show up here as a fetch
 * that still happens.
 *
 * `updateUserPermission` and `useUtils` are stubs: the component calls both
 * during render and neither is the subject.
 */
jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      user: {
        admin: {
          getAllUsers: {
            useQuery: (input: undefined, options: object) =>
              reactQuery.useQuery({
                queryKey: ["getAllUsers", input],
                queryFn: () => queryFn(),
                ...options,
              }),
          },
          updateUserPermission: {
            useMutation: () => ({ mutate: jest.fn() }),
          },
        },
      },
      useUtils: () => ({
        user: { admin: { getAllUsers: { refetch: jest.fn() } } },
      }),
    },
  };
});

restoreViewportAfterEach();

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
const hydrateAt = async (width: number) => {
  setViewportWidth(width);
  queryFn.mockClear();

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
      hydrateRoot(container, tree);
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

    // The whole ticket: that discarded mount used to cost one privileged
    // request for the entire user table, on every mobile load of `/admin`.
    expect(queryFn).not.toHaveBeenCalled();
  });

  it("still fetches when the dashboard survives hydration", async () => {
    await hydrateAt(DESKTOP_WIDTH);

    // The other side, so a component that simply never fetched would fail
    // here. The gate is one render pass of deferral, not a cancellation - and
    // because it carries no viewport term, desktop pays that pass too.
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe("UserManagement on a fresh client mount", () => {
  it("starts its request on the first render, undeferred", async () => {
    setViewportWidth(DESKTOP_WIDTH);
    queryFn.mockClear();

    await act(async () => {
      render(withClient(<UserManagement permission={Permission.MANAGER} />));
    });

    /*
     * `useIsHydrated` reports `true` immediately on a mount that is not
     * hydration, which is the property that makes the gate above cost nothing
     * anywhere else. A `useState(false)` plus mount effect would defer this
     * one too and fail here.
     */
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});
