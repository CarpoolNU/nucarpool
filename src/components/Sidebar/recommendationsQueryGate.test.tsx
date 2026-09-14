/**
 * That a VIEWER's explore page does not pay for recommendations it discards.
 *
 * `user.recommendations.me` runs a ranked scoring pass and returns up to 50
 * candidates. `SidebarContent` short-circuits on `viewerModeHidesCards` ahead
 * of its error, loading and empty branches, so for a VIEWER every one of those
 * candidates was built, sent and thrown away — on first mount and again on
 * every client-side navigation back to `/`, because the call site sets
 * `refetchOnMount: true`. About a third of accounts hold that role (SCRUM-460).
 *
 * **Why this mocks `trpc` onto a real React Query rather than onto a spy.**
 * Same reasoning as `utils/useProfileImage.test.tsx` and
 * `components/Admin/UserManagement.test.tsx`: a render-time `jest.fn()` fires
 * whether or not the query is disabled, so it reports the same count before and
 * after the fix and cannot tell them apart. What has to be established is that
 * the *fetch* went out. So `useQuery` here is the real one, keyed and fetched
 * through a spy `queryFn` — which is what tRPC's `useQuery` reduces to anyway —
 * and the counts below are measurements.
 *
 * **The interaction actually worth pinning is `enabled` against
 * `refetchOnMount: true`.** The call site keeps the latter, and a reader is
 * entitled to wonder whether a refetch-on-mount instruction overrides a gate.
 * It does not, and "a VIEWER pays nothing on a return navigation" is the test
 * that says so rather than a claim in a comment.
 *
 * **What this file does not do.** It reproduces `index.tsx`'s shape rather than
 * importing it — the page pulls in Mapbox, NextAuth and a 1300-line component
 * tree, none of which bears on which queries mount. That is the same trade
 * `UserManagement.test.tsx` documents, and it has the same consequence: this
 * pins the *pattern*, so deleting the `enabled` term from `index.tsx` would not
 * fail here. The control case below is what keeps the pattern honest, by
 * measuring the pre-fix shape in the same harness and showing it does fetch.
 */

import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc } from "../../utils/trpc";
import { roleFetchesRecommendations } from "./viewerAccess";

const recommendationsQueryFn = jest.fn(async () => [] as unknown[]);
const userMeQueryFn = jest.fn(async () => ({ role: currentRole }));

/** The role `user.me` resolves with, set per test. */
let currentRole = "VIEWER";

/**
 * The role the component saw on each render pass. `undefined` is the first
 * pass, before `user.me` resolves — the case the gate has to tolerate without
 * disabling itself permanently.
 */
let rolesSeen: (string | undefined)[] = [];

/**
 * The two `useQuery` calls `index.tsx` makes, as the React Query calls they
 * compile down to. The `options` spread on the recommendations query is what
 * carries `enabled` through, so a fix that computed the gate but failed to pass
 * it would show up here as a fetch that still happens.
 */
jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      user: {
        me: {
          useQuery: () =>
            reactQuery.useQuery({
              queryKey: ["user.me"],
              queryFn: () => userMeQueryFn(),
            }),
        },
        recommendations: {
          me: {
            useQuery: (input: unknown, options: object) =>
              reactQuery.useQuery({
                queryKey: ["recommendations.me", input],
                queryFn: () => recommendationsQueryFn(),
                ...options,
              }),
          },
        },
      },
    },
  };
});

/**
 * The input `index.tsx` passes, at its defaults. Spelled out in full rather
 * than narrowed to the one field the query key needs, because the call site is
 * typed from `AppRouter` and the procedure's Zod input requires all twelve
 * filters — a partial object would not compile here even though the mock never
 * reads it.
 */
const QUERY_INPUT = {
  sort: "any",
  filters: {
    days: 0,
    flexDays: 1,
    startDistance: 20,
    endDistance: 20,
    daysWorking: "",
    startTime: 4,
    endTime: 4,
    startDate: new Date(0),
    endDate: new Date(0),
    dateOverlap: 0,
    favorites: false,
    messaged: false,
  },
};

/**
 * `index.tsx`'s two queries, in its order: the role arrives with `user.me`, and
 * the recommendations gate reads it.
 *
 * `gated` exists only for the control case. `true` is the shipped shape.
 */
const ExplorePage = ({ gated }: { gated: boolean }) => {
  const { data: user = null } = trpc.user.me.useQuery();
  rolesSeen.push(user?.role);

  trpc.user.recommendations.me.useQuery(QUERY_INPUT, {
    refetchOnMount: true,
    ...(gated ? { enabled: roleFetchesRecommendations(user?.role) } : {}),
  });

  return <div>explore</div>;
};

/**
 * One client across a test, so that unmount/remount is a client-side
 * navigation rather than a cold load. `refetchOnMount: false` mirrors the
 * global default in `utils/trpc.ts`, which is what makes `user.me` already
 * cached — and therefore the role already known — on the second mount.
 */
const newClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });

const renderExplore = (client: QueryClient, gated = true) =>
  render(
    <QueryClientProvider client={client}>
      <ExplorePage gated={gated} />
    </QueryClientProvider>,
  );

/**
 * Waits until the component has rendered with the real role, then lets the
 * effects of that render run.
 *
 * Asserting "no fetch" needs a signal that the gate has actually had its
 * chance; without one the assertion passes for the wrong reason, simply by
 * running first. Seeing the role is that signal — it means `user.me` resolved,
 * the component re-rendered, and `enabled` was evaluated against a real value
 * rather than `undefined`. The flush afterwards is what would let the
 * resulting fetch start, and is why the control case below can observe one.
 */
const settleAfterRole = async (role: string) => {
  await waitFor(() => expect(rolesSeen).toContain(role));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  recommendationsQueryFn.mockClear();
  userMeQueryFn.mockClear();
  rolesSeen = [];
  currentRole = "VIEWER";
});

describe("the recommendations query gate", () => {
  it("a VIEWER pays nothing on first mount", async () => {
    currentRole = "VIEWER";

    renderExplore(newClient());
    await settleAfterRole("VIEWER");

    expect(recommendationsQueryFn).toHaveBeenCalledTimes(0);
  });

  it("never fires before the role is known", async () => {
    // The trap the ticket names from the other side. The first pass renders
    // with `user?.role` undefined; a gate that answered `true` there would
    // fire the request for everyone, every time, before the answer existed.
    currentRole = "VIEWER";

    renderExplore(newClient());

    expect(rolesSeen[0]).toBeUndefined();
    expect(recommendationsQueryFn).toHaveBeenCalledTimes(0);
  });

  it("a VIEWER pays nothing on a return navigation either", async () => {
    // The half `refetchOnMount: true` would otherwise own. This is the
    // repeated cost in the ticket: `/` → `/profile` → `/` is a client-side
    // navigation, so before the gate it re-ran the whole scoring pass.
    currentRole = "VIEWER";
    const client = newClient();

    const first = renderExplore(client);
    await settleAfterRole("VIEWER");
    first.unmount();

    renderExplore(client);
    await settleAfterRole("VIEWER");

    expect(recommendationsQueryFn).toHaveBeenCalledTimes(0);
  });

  it.each(["RIDER", "DRIVER"])(
    "a %s still receives recommendations on first mount",
    async (role) => {
      currentRole = role;

      renderExplore(newClient());
      await waitFor(() =>
        expect(recommendationsQueryFn).toHaveBeenCalledTimes(1),
      );
    },
  );

  it("a RIDER still refetches on a return navigation, as before", async () => {
    // `refetchOnMount: true` is unchanged for the roles that use the result —
    // the gate defers the query for one render while `user.me` resolves, it
    // does not cancel it.
    currentRole = "RIDER";
    const client = newClient();

    const first = renderExplore(client);
    await waitFor(() =>
      expect(recommendationsQueryFn).toHaveBeenCalledTimes(1),
    );
    first.unmount();

    renderExplore(client);
    await waitFor(() =>
      expect(recommendationsQueryFn).toHaveBeenCalledTimes(2),
    );
  });

  it("control: the pre-fix shape does fire for a VIEWER", async () => {
    // Without this the cases above would pass just as well against a harness
    // incapable of observing a fetch at all. Measured against the ungated call
    // site, a VIEWER's first mount reports 1.
    currentRole = "VIEWER";

    renderExplore(newClient(), false);
    await waitFor(() =>
      expect(recommendationsQueryFn).toHaveBeenCalledTimes(1),
    );
  });
});
