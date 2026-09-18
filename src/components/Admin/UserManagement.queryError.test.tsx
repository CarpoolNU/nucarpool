/**
 * SCRUM-509: that a failed `getAllUsers` says so, and offers a way out.
 *
 * The Permissions tab is `/admin`'s default, and it used to hold its loading
 * state in a `useState<boolean>(true)` cleared only by an effect watching
 * `users`. Nothing else could clear it, so a failure was a spinner that spun
 * for the rest of the session - and `adminRouter` throws `UNAUTHORIZED` for
 * `permission === "USER"`, which a MANAGER can cause by demoting someone out
 * from under their own live session. Any 500 landed the same way.
 *
 * **`trpc` is mocked onto a real React Query with a rejecting `queryFn`, not
 * onto a stub reporting `isError: true`.** A stub would assert that the
 * component renders `QueryError` when told it failed, which is the easy half.
 * What has to hold is that React Query *reports* a rejected fetch the way the
 * component reads it, and - for the retry - that refetching a failed query
 * really does recover the view. Neither is observable through a hand-written
 * flag. Same reasoning, and the same shape, as
 * `UserManagement.test.tsx`'s spy `queryFn`.
 *
 * `retry: false` on the client so one rejection is one error rather than four
 * attempts; the app's own policy in `utils/trpc.ts` already declines to retry
 * the `UNAUTHORIZED` and `NOT_FOUND` cases this stands in for.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Permission } from "@prisma/client";
import UserManagement from "./UserManagement";
import {
  DESKTOP_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/** Set per test: what the one fetch does. */
let behaviour: () => Promise<unknown[]> = async () => [];
const queryFn = jest.fn(() => behaviour());

const refetchSpy = jest.fn();

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
        user: { admin: { getAllUsers: { refetch: refetchSpy } } },
      }),
    },
  };
});

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
  queryFn.mockClear();
  refetchSpy.mockClear();
  behaviour = async () => [];
});

describe("UserManagement when getAllUsers fails", () => {
  it("renders the error treatment and drops the spinner", async () => {
    behaviour = async () => {
      throw new Error("UNAUTHORIZED");
    };

    renderTab();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not load the user list.");

    // The whole defect: before this the spinner was still there, forever.
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
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  /**
   * The control, and the mutation test for the case above. A component that
   * rendered `QueryError` unconditionally would pass both error assertions and
   * fail here, which is the failure mode the ticket names.
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
   * The third state, which is the one the old boolean could express. Kept here
   * so "spinner while loading" and "error once failed" are pinned against the
   * same component rather than only the second being asserted.
   */
  it("control: shows the spinner while the fetch is still in flight", () => {
    behaviour = () => new Promise(() => undefined);

    renderTab();

    expect(spinner()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
