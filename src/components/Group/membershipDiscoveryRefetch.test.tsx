/**
 * Leaving a carpool re-asks the two questions being in one had made
 * unanswerable: Explore repopulates and the map gets its pins back, without a
 * reload.
 *
 * **The defect (SCRUM-629).** The candidate query deliberately returns nothing
 * to a searcher no driver could accept - `searcherCanMatchNobody` is true for a
 * grouped RIDER, and `buildCandidateWhere` narrows to `id IN ()`. So while the
 * rider is grouped, `recommendations.me` and `mapbox.geoJsonUserList` are
 * correctly empty. `useGroupMembership` then invalidated `user.me` and
 * `groups.me` and nothing else, and nothing else re-asked either: `utils/trpc.ts`
 * turns `refetchOnMount` and `refetchOnWindowFocus` off globally,
 * `pages/index.tsx` owns both queries and renders `GroupPage` *inside* itself
 * so leaving never unmounts the owner, and the query key does not depend on
 * membership. The rider was returned to an empty Explore and an empty map for
 * the rest of the session, which reads exactly like "no drivers match you".
 *
 * **Why this file exists next to the unit tests.** Those assert that
 * `invalidate` was called on the right five caches. That is not the claim that
 * matters, which is that the queries *refetch and redraw*. Invalidation is not
 * sufficient on its own: React Query's `shouldFetchOn` short-circuits on
 * `refetchOnMount === false` before consulting staleness, so an
 * invalidated-but-inactive query still serves cache - `groupMembershipRemount.test.tsx`
 * is the suite that discovered that. What saves this case is that both queries
 * are *active*, because their owner never unmounts; so the test has to hold
 * them mounted and watch the fetch happen.
 *
 * **The client is built from the app's real `defaultQueryOptions`**, reached by
 * `requireActual` past this file's own mock of that module, exactly as
 * `groupMembershipRemount.test.tsx` does. A `QueryClient` with test-local
 * defaults carries React Query's permissive flags, under which this suite would
 * pass against the unfixed code. The control case is what establishes the real
 * policy is in force.
 *
 * **The topology is the app's, not the component tree.** `GroupPage` is not
 * rendered here: what makes the staleness permanent is which component owns the
 * queries relative to which one performs the mutation, and that is a two-line
 * arrangement. `Explore` below owns the queries and never unmounts; `Membership`
 * renders inside it and calls the hook. Rendering the real page instead would
 * drag in Mapbox, Pusher and the sidebar without making the arrangement any
 * more faithful.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc } from "../../utils/trpc";
import { trpcSpies, resetTrpcSpies } from "../../testing/trpcHarness";
import type { FiltersState } from "../../utils/types";
import { useGroupMembership } from "./useGroupMembership";

const GROUP_ID = "group-1";
const CALLER = "rider-caller";
const DRIVER = "driver-1";

/**
 * What each discovery query answers, in order. The first answer is the empty
 * one the server correctly gives a grouped rider; the second is the one that
 * only becomes true once they have left.
 */
const recommendationsFn = jest.fn();
const mapUsersFn = jest.fn();
/** The control: active, same client, and not part of a membership change. */
const blocksFn = jest.fn();

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    // Real `invalidate`, reaching the live client. The harness hands these
    // stubs the `QueryClient` the provider below is holding, which is the
    // whole reason this file can watch a refetch rather than a spy.
    //
    // The harness keys every query as `[path, input]`, so a prefix of the path
    // alone matches whatever input the component passed.
    "user.recommendations.me": {
      query: () => recommendationsFn(),
      invalidate: (client: QueryClient) =>
        client.invalidateQueries({ queryKey: ["user.recommendations.me"] }),
    },
    "mapbox.geoJsonUserList": {
      query: () => mapUsersFn(),
      invalidate: (client: QueryClient) =>
        client.invalidateQueries({ queryKey: ["mapbox.geoJsonUserList"] }),
    },
    // Active throughout and never invalidated by a membership change. Its
    // `invalidate` is deliberately left as the harness's inert spy, so if the
    // shared set ever grew to include it this control would start failing.
    "user.blocks.me": {
      query: () => blocksFn(),
      invalidate: (client: QueryClient) =>
        client.invalidateQueries({ queryKey: ["user.blocks.me"] }),
    },
    // The leave itself: a real `useMutation`, so `onSuccess` runs on React
    // Query's own timeline rather than being called by hand.
    "user.groups.edit": { mutation: () => ({ id: GROUP_ID }) },
    // Wired up by the hook but never fired here.
    "user.groups.delete": { inertMutation: true },
    // The rest of the set. Declared so `useUtils` has them to invalidate -
    // without them the hook throws - and left inert, because reaching the
    // cache for these would refetch queries this file is not about.
    "user.me": {},
    "user.groups.me": {},
    "user.requests.me": {},
  }),
);

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

/** The real policy object, past this file's own mock of the module. */
const { defaultQueryOptions } = jest.requireActual("../../utils/trpc");

type Candidate = { id: string; preferredName: string };

/**
 * A complete `FiltersState`, because the input is typed from `AppRouter` even
 * though the mock never reads it - only the runtime is faked here, the types
 * are the app's. Fixed dates rather than `new Date()`, so the query key is
 * stable across the two renders in a case.
 */
const FILTERS: FiltersState = {
  days: 0,
  flexDays: 1,
  startDistance: 0,
  endDistance: 0,
  daysWorking: "",
  startTime: 0,
  endTime: 0,
  startDate: new Date("2026-01-01T00:00:00.000Z"),
  endDate: new Date("2026-06-01T00:00:00.000Z"),
  dateOverlap: 0,
  favorites: false,
  messaged: false,
};

/**
 * `data` off each query, read as the list these stubs resolve.
 *
 * Through `unknown` because `geoJsonUserList` is really typed as a GeoJSON
 * `FeatureCollection`: what each query *returns* is beside the point here,
 * which is whether it was asked again at all.
 */
const names = (data: unknown): string => {
  const candidates = data as Candidate[] | undefined;
  if (candidates === undefined) return "loading";
  if (candidates.length === 0) return "no drivers match you";
  return candidates.map((candidate) => candidate.preferredName).join(", ");
};

/** Stands in for `GroupPage`: renders inside the owner, performs the leave. */
const Membership = () => {
  const { handleRemoveRider } = useGroupMembership({
    groupId: GROUP_ID,
    driverId: DRIVER,
    currentUserId: CALLER,
  });
  return (
    <button type="button" onClick={() => handleRemoveRider(CALLER)}>
      Leave Group
    </button>
  );
};

/**
 * Stands in for `pages/index.tsx`: owns both discovery queries and renders the
 * group view inside itself, so nothing here ever unmounts.
 *
 * The options are the app's. `recommendations.me` carries the
 * `refetchOnMount: true` opt-in added by SCRUM-609 - which is exactly the
 * option that looks like it should have covered this and cannot, because the
 * owner does not unmount - and `geoJsonUserList` passes none at all.
 */
const Explore = () => {
  const recommendations = trpc.user.recommendations.me.useQuery(
    { sort: "any", filters: FILTERS },
    { refetchOnMount: true },
  );
  const mapUsers = trpc.mapbox.geoJsonUserList.useQuery(FILTERS);
  const blocks = trpc.user.blocks.me.useQuery();

  return (
    <div>
      <p>sidebar: {names(recommendations.data)}</p>
      <p>map: {names(mapUsers.data)}</p>
      <p>blocked: {names(blocks.data)}</p>
      <Membership />
    </div>
  );
};

const DANA: Candidate = { id: "dana", preferredName: "Dana" };

beforeEach(() => {
  resetTrpcSpies();
  recommendationsFn.mockReset();
  mapUsersFn.mockReset();
  blocksFn.mockReset();
  // Nobody is reachable while the caller is grouped, and Dana is reachable
  // once they are not. Same shape for both queries: one is the sidebar's
  // cards, the other the map's pins, and the server answers both from the same
  // candidate query.
  recommendationsFn.mockResolvedValueOnce([]).mockResolvedValue([DANA]);
  mapUsersFn.mockResolvedValueOnce([]).mockResolvedValue([DANA]);
  blocksFn.mockResolvedValue([]);
});

const renderExplore = () => {
  const client = new QueryClient({
    defaultOptions: { queries: defaultQueryOptions },
  });
  render(
    <QueryClientProvider client={client}>
      <Explore />
    </QueryClientProvider>,
  );
};

describe("a rider who leaves a carpool", () => {
  it("gets Explore and the map back without reloading the page", async () => {
    renderExplore();

    // The state being left: both surfaces correctly empty, because a grouped
    // rider can join nobody.
    expect(
      await screen.findByText("sidebar: no drivers match you"),
    ).toBeVisible();
    expect(await screen.findByText("map: no drivers match you")).toBeVisible();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Leave Group" }));

    // The rendered effect, not just the fetch. React Query v5 notifies on a
    // `setTimeout(0)`, so a refetch resolving is not the same event as the
    // list being redrawn - Dana appearing is the barrier that says it has been.
    expect(await screen.findByText("sidebar: Dana")).toBeVisible();
    expect(await screen.findByText("map: Dana")).toBeVisible();
    expect(screen.queryByText("sidebar: no drivers match you")).toBeNull();

    // Both went through the shared helper's `invalidate`, which is what the
    // refetch above was caused by.
    expect(trpcSpies("user.recommendations.me").invalidate).toHaveBeenCalled();
    expect(trpcSpies("mapbox.geoJsonUserList").invalidate).toHaveBeenCalled();

    // Once each, which is the cost this change accepts and the whole of it:
    // one scoring pass and one Mapbox-metered request per membership change.
    // `utils/trpc.ts` turns the refetch flags off globally because these two
    // are expensive, so a fix that re-asked twice would be trading one defect
    // for the cost the policy exists to avoid.
    expect(recommendationsFn).toHaveBeenCalledTimes(2);
    expect(mapUsersFn).toHaveBeenCalledTimes(2);
  });

  /*
   * The control, and the reason the case above means anything.
   *
   * `blocks.me` is mounted beside the two discovery queries, on the same
   * client, with the same real `defaultQueryOptions`, and its `invalidate`
   * reaches the cache for real too - the only difference is that a membership
   * change does not call it. If the client were permissive, or if the fix
   * invalidated broadly instead of by name, this would refetch as well and the
   * assertions above would be telling us nothing about the fix. The two cases
   * move together or this file is lying.
   *
   * It is also the `No query outside that set is invalidated` acceptance
   * criterion, read off a real client rather than off a list of spies.
   *
   * It takes the subject's own barrier - Dana appearing - on purpose, so it
   * cannot pass by checking a moment before any refetch could have happened.
   * The consequence is that this case fails alongside the one above on
   * unfixed code rather than passing beside it, which is the right trade: a
   * control that holds while nothing has happened yet is not a control.
   */
  it("does not refetch a query the membership change did not touch", async () => {
    renderExplore();

    expect(
      await screen.findByText("blocked: no drivers match you"),
    ).toBeVisible();
    await waitFor(() => expect(blocksFn).toHaveBeenCalledTimes(1));
    const callsBefore = blocksFn.mock.calls.length;

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Leave Group" }));

    // Barrier first: wait for the leave to have done its work, so this is not
    // asserting on a moment before any refetch could have happened.
    expect(await screen.findByText("sidebar: Dana")).toBeVisible();

    expect(blocksFn).toHaveBeenCalledTimes(callsBefore);
    expect(trpcSpies("user.blocks.me").invalidate).not.toHaveBeenCalled();
  });
});
