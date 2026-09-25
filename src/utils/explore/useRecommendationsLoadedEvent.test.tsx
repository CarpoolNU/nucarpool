/**
 * SCRUM-570: that a rider's recommendations count reaches Mixpanel, once per
 * resolved load, and that a VIEWER's silence is not mistaken for unmet demand.
 *
 * **Real React Query, a spy `queryFn`, and the real `utils/mixpanel`.** The
 * subject is *when* an event fires relative to a query's lifecycle, so a
 * hand-rolled fake query would be the thing under test rather than the thing
 * driving it. `mixpanel-browser` is mocked locally instead of `utils/mixpanel`
 * — the same trade `src/testing/mixpanelBrowserStub.js` records — so the event
 * name and the exact property bag travel through the real wrapper and can be
 * asserted as a whole. That is what AC 4 needs: "no coordinate is sent" is a
 * claim about everything in the payload, not about the fields a test
 * remembered to check.
 *
 * **StrictMode is on** (`jest.setup.dom.ts` configures it, because
 * `next.config.js` does). Effects therefore mount, clean up and mount again on
 * every first render, so "fires once" here measures the hook's idempotence
 * rather than a single effect invocation.
 *
 * The page itself is not mounted: `index.tsx` is Mapbox, Pusher and a dozen
 * queries, and the subject is one hook. `Harness` reproduces the two queries
 * it reads and the `enabled` gate between them, which is the same trade
 * `components/Sidebar/recommendationsQueryGate.test.tsx` documents.
 */

import { act, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import React, { useState } from "react";
import { roleFetchesRecommendations } from "../../components/Sidebar/viewerAccess";
import { User } from "../types";
import { useRecommendationsLoadedEvent } from "./useRecommendationsLoadedEvent";

const mockTrack = jest.fn();

/**
 * Local, so it takes precedence over the `moduleNameMapper` stub and
 * `utils/mixpanel` loads for real above it.
 */
jest.mock("mixpanel-browser", () => ({
  __esModule: true,
  default: {
    init: () => undefined,
    track: (...args: unknown[]) => mockTrack(...args),
  },
}));

type Profile = Pick<User, "role" | "companyCity" | "companyState">;

/** The profile `user.me` resolves with, set per test. */
let profile: Profile = {
  role: "RIDER",
  companyCity: "Boston",
  companyState: "Massachusetts",
};

/** How many candidates the next recommendations fetch resolves with. */
let candidateCount = 0;

/**
 * Set to a placeholder to hold `recommendations.me` open; the fetch overwrites
 * it with the resolver that lets it finish.
 */
let releaseRecommendations: (() => void) | null = null;

const userQueryFn = jest.fn(async (): Promise<Profile> => ({ ...profile }));

const recommendationsQueryFn = jest.fn(async () => {
  if (releaseRecommendations !== null) {
    await new Promise<void>((resolve) => {
      releaseRecommendations = resolve;
    });
  }
  return Array.from({ length: candidateCount }, (_, i) => ({ id: `u${i}` }));
});

/**
 * `index.tsx`'s shape, narrowed to what this hook reads: the profile, the
 * gated recommendations query, and the hook between them.
 *
 * `gated` exists for the control cases below — it removes the `enabled` term
 * so a VIEWER's query really does resolve, which is the only way to show that
 * the hook's own role check does something rather than riding on the page's.
 */
const Harness = ({
  gated = true,
  filterKey = 0,
}: {
  gated?: boolean;
  filterKey?: number;
}) => {
  const { data: user = null } = useQuery({
    queryKey: ["user.me"],
    queryFn: () => userQueryFn(),
  });

  const recommendationsQuery = useQuery({
    queryKey: ["recommendations.me", filterKey],
    queryFn: () => recommendationsQueryFn(),
    refetchOnMount: true,
    ...(gated ? { enabled: roleFetchesRecommendations(user?.role) } : {}),
  });

  useRecommendationsLoadedEvent(recommendationsQuery, user);

  return <div>explore</div>;
};

/** Re-renders `Harness` with identical props, to separate render from load. */
const Rerenderable = () => {
  const [, setTick] = useState(0);
  return (
    <>
      <button onClick={() => setTick((t) => t + 1)}>rerender</button>
      <Harness />
    </>
  );
};

const newClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });

const renderHarness = (
  client: QueryClient,
  node: React.ReactElement = <Harness />,
) => render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);

/** Lets pending microtasks and React Query's `setTimeout(0)` notification run. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** The events this hook emitted, as `[name, properties]` pairs. */
const loadedEvents = (): [string, Record<string, unknown>][] =>
  mockTrack.mock.calls.filter(([name]) => name === "Recommendations Loaded");

beforeEach(() => {
  mockTrack.mockClear();
  userQueryFn.mockClear();
  recommendationsQueryFn.mockClear();
  profile = {
    role: "RIDER",
    companyCity: "Boston",
    companyState: "Massachusetts",
  };
  candidateCount = 0;
  releaseRecommendations = null;
});

describe("the Recommendations Loaded event", () => {
  it("fires once with resultCount 0 when a rider's list resolves empty", async () => {
    candidateCount = 0;

    renderHarness(newClient());
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));
    await settle();

    expect(loadedEvents()).toHaveLength(1);
    expect(loadedEvents()[0][1]).toEqual({
      resultCount: 0,
      role: "RIDER",
      companyCity: "Boston",
      companyState: "Massachusetts",
    });
  });

  it("fires once with the real count when the list is populated", async () => {
    candidateCount = 7;

    renderHarness(newClient());
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));
    await settle();

    expect(loadedEvents()).toHaveLength(1);
    expect(loadedEvents()[0][1]).toMatchObject({ resultCount: 7 });
  });

  it("sends no address and no coordinate", async () => {
    // AC 4, asserted over the whole payload rather than field by field: a
    // property added here later has to be named in this list to pass.
    candidateCount = 3;

    renderHarness(newClient());
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));

    expect(Object.keys(loadedEvents()[0][1]).sort()).toEqual([
      "companyCity",
      "companyState",
      "resultCount",
      "role",
    ]);
  });

  it("does not fire while the query is still loading", async () => {
    // The regression case. A count read off a not-yet-loaded list is zero for
    // everyone, which would read as a total driver drought.
    releaseRecommendations = () => undefined;

    renderHarness(newClient());
    await waitFor(() => expect(recommendationsQueryFn).toHaveBeenCalled());
    await settle();

    expect(loadedEvents()).toHaveLength(0);

    // ... and does fire once it resolves, so the silence above is the gate
    // rather than a harness that could never observe an event.
    candidateCount = 2;
    const release = releaseRecommendations as () => void;
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(loadedEvents()).toHaveLength(1));
    expect(loadedEvents()[0][1]).toMatchObject({ resultCount: 2 });
  });

  it("does not fire again on a re-render that loaded nothing new", async () => {
    candidateCount = 4;
    const { getByText } = renderHarness(newClient(), <Rerenderable />);
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));

    await act(async () => {
      getByText("rerender").click();
      getByText("rerender").click();
    });
    await settle();

    expect(loadedEvents()).toHaveLength(1);
  });

  it("does not double-report a list that was already cached at mount", async () => {
    // The case the dedupe ref actually exists for, and the only one that puts
    // StrictMode's double-invoked mount effect on the *emitting* path. On a
    // cold load the effect's first runs happen while the query is still
    // pending, so the guard is never reached; on a return navigation the
    // cached list is already there at mount and the very first run reports.
    //
    // The refetch is held open so this measures the cached pass alone.
    candidateCount = 4;
    const client = newClient();
    const first = renderHarness(client);
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));
    first.unmount();
    mockTrack.mockClear();

    releaseRecommendations = () => undefined;
    renderHarness(client);
    await settle();

    expect(loadedEvents()).toHaveLength(1);
  });

  it("does not re-report the same load when the profile changes under it", async () => {
    // `role`, `companyCity` and `companyState` are effect dependencies because
    // the event carries them, so a profile edit re-runs the effect against a
    // load that has not changed. Without the ref that is a second event
    // carrying the first search's count.
    candidateCount = 5;
    const client = newClient();
    renderHarness(client);
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));

    profile = { ...profile, companyCity: "Cambridge" };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["user.me"] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    expect(loadedEvents()).toHaveLength(1);
  });

  it("reports the cached list and the refetched one on a return navigation", async () => {
    // Documented rather than prevented: the call site sets
    // `refetchOnMount: true`, so coming back to `/` shows the cached list and
    // then the fresh one, and both are lists the rider saw. Suppressing the
    // first would tie this hook to the call site's caching options. Pinned so
    // that whoever trends this knows to count unique users, not raw events.
    candidateCount = 4;
    const client = newClient();
    const first = renderHarness(client);
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));
    first.unmount();
    mockTrack.mockClear();

    candidateCount = 6;
    renderHarness(client);

    await waitFor(() => expect(loadedEvents()).toHaveLength(2));
    expect(loadedEvents()[0][1]).toMatchObject({ resultCount: 4 });
    expect(loadedEvents()[1][1]).toMatchObject({ resultCount: 6 });
  });

  it("fires again when changed filters resolve a new list", async () => {
    // A second search is a second load, and its count is the point.
    candidateCount = 4;
    const client = newClient();
    const { rerender } = renderHarness(client, <Harness filterKey={0} />);
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));

    candidateCount = 1;
    rerender(
      <QueryClientProvider client={client}>
        <Harness filterKey={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(loadedEvents()).toHaveLength(2));
    expect(loadedEvents()[1][1]).toMatchObject({ resultCount: 1 });
  });

  it("stays silent for a VIEWER, whose query never runs", async () => {
    profile = { role: "VIEWER", companyCity: "", companyState: "" };

    renderHarness(newClient());
    await waitFor(() => expect(userQueryFn).toHaveBeenCalled());
    await settle();

    expect(recommendationsQueryFn).toHaveBeenCalledTimes(0);
    expect(loadedEvents()).toHaveLength(0);
  });

  it("stays silent for a VIEWER even when the query does resolve", async () => {
    // The control for the case above, which on its own only re-establishes
    // SCRUM-460's gate. Ungated, a VIEWER's query resolves with an empty list
    // — 13 of the 301 live searches — and that zero is a role, not a shortage.
    profile = { role: "VIEWER", companyCity: "", companyState: "" };
    candidateCount = 0;

    renderHarness(newClient(), <Harness gated={false} />);
    await waitFor(() => expect(recommendationsQueryFn).toHaveBeenCalled());
    await settle();

    expect(loadedEvents()).toHaveLength(0);
  });

  it("control: an ungated RIDER in the same harness does emit", async () => {
    // Without this the two silences above would pass just as well against a
    // harness that cannot observe an event at all.
    candidateCount = 0;

    renderHarness(newClient(), <Harness gated={false} />);
    await waitFor(() => expect(loadedEvents()).toHaveLength(1));
  });
});
