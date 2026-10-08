import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Role } from "@prisma/client";
import { GroupPage } from "./GroupPage";
import { UserContext } from "../../utils/userContext";
import { DEFAULT_GROUP_DETAILS } from "./groupDetails";
import type { PublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * My Group shows the membership as it is now, not as it was when the driver
 * last looked.
 *
 * **Why `groups.me` needs explicit invalidation reach.** `groups.me` takes
 * no refetch options, `utils/trpc.ts` turns `refetchOnMount` off globally,
 * and `GroupSection` unmounts whenever the modal closes or the sidebar tab
 * changes. The three invalidation sites - `requestHandlers.ts`,
 * `useGroupDetails.ts`, `useGroupMembership.ts` - all run in the client of
 * whoever performed the mutation, so a rider leaving does not touch the
 * driver's cache on its own. Without something re-asking the server, a
 * driver reopening My Group inside the five-minute `gcTime` would be shown
 * the departed rider, with a "Remove" button beside them and included in
 * "Preview Group Route".
 *
 * **Invalidation alone cannot fix this from either side.** Not from the
 * rider's client, which cannot reach the driver's cache; and not from the
 * driver's, because React Query's `shouldFetchOn` short-circuits on
 * `refetchOnMount === false` before it ever consults staleness, so an
 * invalidated-but-inactive query still serves cache on the next mount. The
 * behaviour that matters is "a second mount re-asks the server", which is what
 * this counts.
 *
 * **The client is built from the app's real `defaultQueryOptions`**, reached
 * through `requireActual` past this file's own mock of that module. A
 * `QueryClient` with test-local defaults carries React Query's permissive
 * `refetchOnMount`, under which this suite would pass even if the real
 * policy were never applied - so the count alone would prove nothing. The
 * control case is what establishes that the real policy is in force.
 *
 * Desktop width throughout: the mobile branch is a different view of the same
 * query, and which view renders is not what this file is about. jsdom does no
 * layout - see `src/testing/viewport.ts`.
 */

const groupsQueryFn = jest.fn();

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.groups.me": { query: () => groupsQueryFn() },
    // Wired up by `useGroupMembership` behind the member rows' Leave and
    // Remove buttons. Inert: this file is about what the list shows, not about
    // changing it, and an inert mutation keeps the real one from reaching the
    // cache mid-assertion.
    "user.groups.edit": { inertMutation: true },
    "user.groups.delete": { inertMutation: true },
    // `UserActionsMenu` now sits on every member row that is not the reader's
    // own, and its block confirmation mounts with the row. Inert for the same
    // reason as the two above.
    "user.blocks.block": { inertMutation: true },
  }),
);

/**
 * Mocked out because it owns a mutation and a second query of its own, and the
 * driver's group message is not what this file is about. `GroupPage.test.tsx`
 * mocks it for the same reason and documents why the real default shape is used
 * rather than a hand-written literal, whose keys had drifted.
 */
jest.mock("./useGroupDetails", () => ({
  useGroupDetails: () => ({
    details: require("./groupDetails").DEFAULT_GROUP_DETAILS,
    setDetails: () => undefined,
    save: () => undefined,
    isSaving: false,
  }),
}));

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

/** The real policy object, past this file's own mock of the module. */
const { defaultQueryOptions } = jest.requireActual("../../utils/trpc");

const GROUP_ID = "group-1";

const member = (id: string, preferredName: string, role: Role): PublicUser =>
  ({
    id,
    preferredName,
    role,
    email: `${id}@northeastern.edu`,
    carpoolId: GROUP_ID,
  }) as unknown as PublicUser;

const DANA = member("dana", "Dana", Role.DRIVER);
const RILEY = member("riley", "Riley", Role.RIDER);
const JO = member("jo", "Jo", Role.RIDER);

/** The driver, who is the one served the stale list. */
const CUR_USER = DANA as unknown as User;

const group = (users: PublicUser[]) => ({
  id: GROUP_ID,
  hasDriver: true,
  preferences: DEFAULT_GROUP_DETAILS,
  users,
});

restoreViewportAfterEach();

beforeEach(() => {
  setViewportWidth(DESKTOP_WIDTH);
  groupsQueryFn.mockReset();
});

describe("My Group reopened after a member leaves", () => {
  it("re-reads the membership on the second visit", async () => {
    // Riley is in the group when the driver first looks, and gone by the time
    // they look again - the leave happened in Riley's client, so nothing on
    // this one was told about it.
    groupsQueryFn
      .mockResolvedValueOnce(group([DANA, RILEY, JO]))
      .mockResolvedValue(group([DANA, JO]));

    const client = new QueryClient({
      defaultOptions: { queries: defaultQueryOptions },
    });
    const withClient = (
      <QueryClientProvider client={client}>
        <UserContext.Provider value={CUR_USER}>
          <GroupPage
            onClose={() => undefined}
            onViewGroupRoute={() => undefined}
          />
        </UserContext.Provider>
      </QueryClientProvider>
    );

    const first = render(withClient);

    expect(await screen.findByText("Riley")).toBeVisible();
    await waitFor(() => expect(groupsQueryFn).toHaveBeenCalledTimes(1));
    const callsBefore = groupsQueryFn.mock.calls.length;

    // Closing the modal, or switching the sidebar tab, unmounts the section.
    // The cache outlives it for the default `gcTime`, which is the window the
    // departed rider stayed on screen in.
    first.unmount();

    // The same client, deliberately: a fresh one would discard the cache and
    // force a load whatever `refetchOnMount` said, which is the reading this
    // test exists to rule out.
    render(withClient);

    await waitFor(() =>
      expect(groupsQueryFn).toHaveBeenCalledTimes(callsBefore + 1),
    );

    // The rendered effect, not just the fetch. React Query v5 notifies on a
    // `setTimeout(0)`, so the refetch resolving is not the same event as the
    // list being redrawn - Jo arriving is the barrier that says it has been.
    expect(await screen.findByText("Jo")).toBeVisible();
    expect(screen.queryByText("Riley")).toBeNull();
  });

  it("does not re-read a query that has not opted in", async () => {
    /*
     * The control, and the reason the count above means anything.
     *
     * This is the same component and the same remount with the opt-in
     * subtracted - `refetchOnMount` taken back to the global default at the
     * call site. If the test client were permissive, this would refetch too and
     * the assertion above would be telling us nothing about the fix. The two
     * cases move together or this file is lying.
     *
     * It reads the policy through the same real `QueryClient` rather than
     * asserting on the shape of `defaultQueryOptions`, which is the discipline
     * `trpc.focusPolicy.test.tsx` sets out: a spy `queryFn` is the jsdom
     * stand-in for the network panel.
     */
    const client = new QueryClient({
      defaultOptions: { queries: defaultQueryOptions },
    });
    const Control = () => {
      const { useQuery } = jest.requireActual("@tanstack/react-query");
      const query = useQuery({
        queryKey: ["control"],
        queryFn: () => groupsQueryFn(),
      });
      return <div>{query.isSuccess ? "control ready" : "control loading"}</div>;
    };

    groupsQueryFn.mockResolvedValue(group([DANA, JO]));

    const withClient = (
      <QueryClientProvider client={client}>
        <Control />
      </QueryClientProvider>
    );

    const first = render(withClient);
    expect(await screen.findByText("control ready")).toBeVisible();
    await waitFor(() => expect(groupsQueryFn).toHaveBeenCalledTimes(1));
    const callsBefore = groupsQueryFn.mock.calls.length;

    first.unmount();
    render(withClient);

    // Rendered from cache, with no fetch - which is what the global policy
    // says, and what My Group was subject to before it opted out.
    expect(await screen.findByText("control ready")).toBeVisible();
    expect(groupsQueryFn).toHaveBeenCalledTimes(callsBefore);
  });
});
