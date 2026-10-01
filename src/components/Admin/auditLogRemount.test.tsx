import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminAuditLog from "./AdminAuditLog";

/**
 * The audit log is re-read when the admin comes back to it.
 *
 * **The defect.** `admin.updateUserPermission` and `admin.resolveReport` each
 * append an `AdminAuditLog` row inside their transaction, and both are
 * reachable only from `UserManagement` and `AdminReports`. `/admin` renders
 * exactly one panel at a time, so this query is always inactive when a row is
 * written and always remounting when the admin returns - and `utils/trpc.ts`
 * turns `refetchOnMount` off globally. The admin changed a permission, clicked
 * back to Audit Log, and their own action was not there.
 *
 * **Why this is a remount test and not an invalidation test.** The obvious fix
 * was an `invalidate()` in those two mutations' `onSuccess`, and it does not
 * work: `invalidateQueries` defaults to `refetchType: "active"` so an inactive
 * query is only marked, and React Query's `shouldFetchOn` consults
 * `refetchOnMount` *before* staleness, so the mark changes nothing on the
 * remount either. The behaviour that matters is therefore "a second mount
 * re-asks", which is what this counts. It is also the only version of the fix
 * that can show another admin's actions.
 *
 * **The client is built from the app's own `defaultQueryOptions`**, taken
 * through `requireActual` because this file mocks the module they live in. That
 * is the whole point: a `QueryClient` built with test-local defaults has
 * `refetchOnMount` at React Query's permissive default, under which this suite
 * would pass against the unfixed component. The control case below is what
 * proves the real policy is in force.
 *
 * Counts are read off the `queryFn`, not off a render-time spy, for the reason
 * `trpcHarness.ts` gives: a render-time mock fires on passes React discards and
 * cannot tell a query that fetched from one that did not.
 */

const auditLogQueryFn = jest.fn();
const usersQueryFn = jest.fn();

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.admin.getAuditLog": { query: () => auditLogQueryFn() },
    "user.admin.getAllUsers": { query: () => usersQueryFn() },
  }),
);

/** The real policy object, past this file's own mock of the module. */
const { defaultQueryOptions } = jest.requireActual("../../utils/trpc");

const ACTOR = {
  id: "manager-1",
  email: "manager@northeastern.edu",
  permission: "MANAGER",
};

const row = (id: string, action: string) => ({
  id,
  actorId: ACTOR.id,
  action,
  targetId: "user-2",
  metadata: JSON.stringify({ permission: "ADMIN" }),
  dateCreated: new Date(2026, 8, 1, 10, 30),
});

/** Already in the log when the admin left the tab. */
const OLD_ROW = row("log-1", "user.admin.resolveReport");

/** Written by the admin's own permission change while they were elsewhere. */
const NEW_ROW = row("log-2", "user.admin.updateUserPermission");

beforeEach(() => {
  auditLogQueryFn.mockReset();
  usersQueryFn.mockReset();
  usersQueryFn.mockResolvedValue([ACTOR]);
});

describe("the admin audit log across a tab change", () => {
  it("re-reads the log on a second visit, and leaves the un-opted-in query alone", async () => {
    // The log as it stood when the admin left the tab, and as it stands when
    // they come back - one row longer, because their own action is now in it.
    auditLogQueryFn
      .mockResolvedValueOnce([OLD_ROW])
      .mockResolvedValue([NEW_ROW, OLD_ROW]);

    const client = new QueryClient({
      defaultOptions: { queries: defaultQueryOptions },
    });
    const withClient = (
      <QueryClientProvider client={client}>
        <AdminAuditLog />
      </QueryClientProvider>
    );

    const first = render(withClient);
    // Settle the first visit before counting anything, so the remount's fetch
    // cannot be confused with the initial one still in flight.
    expect(await screen.findByText(OLD_ROW.action)).toBeVisible();
    // The admin's action is genuinely absent to begin with. Without this the
    // closing assertion could pass against a component that had shown it all
    // along.
    expect(screen.queryByText(NEW_ROW.action)).toBeNull();
    await waitFor(() => expect(auditLogQueryFn).toHaveBeenCalledTimes(1));

    const logCallsBefore = auditLogQueryFn.mock.calls.length;
    const usersCallsBefore = usersQueryFn.mock.calls.length;

    // Leaving the Audit Log tab for another panel unmounts this component; the
    // cache outlives it for the five minutes of the default `gcTime`, which is
    // the window the admin's own action went missing in.
    first.unmount();

    // The same client, deliberately. A fresh one would discard the cache and
    // force a load whatever `refetchOnMount` said, which is precisely the
    // reading this test has to rule out.
    render(withClient);

    await waitFor(() =>
      expect(auditLogQueryFn).toHaveBeenCalledTimes(logCallsBefore + 1),
    );

    /*
     * The control, and the reason the assertion above means anything.
     *
     * `getAllUsers` is read by this same component on the same mount and takes
     * the defaults. If the test client's `refetchOnMount` were permissive -
     * which is how every other suite here builds its client - this count would
     * have gone up too, and the assertion above would be telling us nothing
     * about the opt-in. The two move together or the file is lying.
     */
    expect(usersQueryFn).toHaveBeenCalledTimes(usersCallsBefore);

    // And the point of all of it: the row written while the admin was on
    // another tab is on screen.
    expect(await screen.findByText(NEW_ROW.action)).toBeVisible();
  });
});
