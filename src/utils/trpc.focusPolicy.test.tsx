import { act, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  type UseQueryOptions,
} from "@tanstack/react-query";
import React from "react";
import { defaultQueryOptions, realTimeQueryOptions } from "./trpc";

/**
 * The refetch-on-focus policy, exercised rather than read.
 *
 * The acceptance criterion this file exists for says to verify the expensive
 * queries stay put "in the network panel, not by reading config" - so nothing
 * here asserts on the shape of `defaultQueryOptions`. Instead it builds a real
 * `QueryClient` from those defaults, mounts queries configured exactly the way
 * the four real call sites configure theirs, and counts how many times each
 * `queryFn` actually ran across a background/foreground cycle. A spy `queryFn`
 * is the jsdom stand-in for the network panel.
 *
 * **The negative assertions are the point, and negative assertions pass
 * vacuously.** A test that says "`recommendations` did not refetch" also passes
 * when nothing refetched at all, when the event never reached React Query, or
 * when the provider never mounted. Every case below therefore asserts the
 * opt-in queries *did* refetch in the same breath, so the control and the
 * subject move together or the test is lying.
 *
 * `visibilitychange` is dispatched on `window`, and `document.visibilityState`
 * is redefined around it, because that is precisely what @tanstack/query-core's
 * `focusManager` listens to and reads: the listener is registered with
 * `window.addEventListener("visibilitychange", ...)` and focus is computed as
 * `document.visibilityState !== "hidden"`. Dispatching on `document` alone does
 * not reach it.
 */

/**
 * The four call sites, built from the **same exported constant the components
 * spread**, so this exercises the real policy object rather than a copy of it.
 *
 * What that does and does not buy: editing `realTimeQueryOptions` to something
 * that stops working fails these tests, and so does a React Query upgrade that
 * changes how focus refetching behaves. Deleting the spread from one component
 * would not - nothing short of rendering `Header` or `index.tsx` can catch
 * that, and neither is renderable in jsdom, which is the same reason
 * `useUnreadNotifications` and `mobileNavPlan` were lifted out of them.
 */
const CALL_SITES = {
  /** `Header` - the unread badge. */
  unreadCount: { ...realTimeQueryOptions },
  /** `index.tsx` - request cards, unread dots, message previews. */
  requestsMe: { refetchOnMount: "always", ...realTimeQueryOptions },
  /** `index.tsx` - the scoring pass. Takes the defaults, deliberately. */
  recommendations: {},
  /** `index.tsx` - metered against the Mapbox quota. Takes the defaults. */
  geoJsonUserList: {},
} as const;

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
};

/** One background/foreground cycle, as a locked phone produces it. */
const backgroundAndReturn = async () => {
  await act(async () => {
    setVisibility("hidden");
    window.dispatchEvent(new Event("visibilitychange"));
  });

  await act(async () => {
    setVisibility("visible");
    window.dispatchEvent(new Event("visibilitychange"));
  });
};

type Spies = Record<keyof typeof CALL_SITES, jest.Mock>;

const renderApp = async (spies: Spies) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: defaultQueryOptions },
  });

  const Query = ({
    name,
    options,
  }: {
    name: keyof typeof CALL_SITES;
    options: Partial<UseQueryOptions>;
  }) => {
    useQuery({
      queryKey: [name],
      queryFn: spies[name] as () => Promise<string>,
      ...(options as object),
    });
    return null;
  };

  const view = render(
    <QueryClientProvider client={queryClient}>
      {(Object.keys(CALL_SITES) as Array<keyof typeof CALL_SITES>).map(
        (name) => (
          <Query key={name} name={name} options={CALL_SITES[name]} />
        ),
      )}
    </QueryClientProvider>,
  );

  // Every query has to have settled before a focus event means anything: a
  // query still in flight would not refetch regardless of its flags, which
  // would make the negative assertions pass for the wrong reason.
  await waitFor(() => {
    Object.values(spies).forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });

  return { view, queryClient };
};

let spies: Spies;

beforeEach(() => {
  setVisibility("visible");
  spies = {
    unreadCount: jest.fn(async () => "unread"),
    requestsMe: jest.fn(async () => "requests"),
    recommendations: jest.fn(async () => "recommendations"),
    geoJsonUserList: jest.fn(async () => "geojson"),
  };
});

describe("refetch-on-focus policy", () => {
  it("refetches the messaging queries when the tab comes back", async () => {
    // The bug: three messages arrive while the phone is locked, and returning
    // to the tab refetched nothing, so the thread and the badge stayed short of
    // the server for the rest of the session.
    await renderApp(spies);

    await backgroundAndReturn();

    await waitFor(() => {
      expect(spies.unreadCount).toHaveBeenCalledTimes(2);
      expect(spies.requestsMe).toHaveBeenCalledTimes(2);
    });
  });

  it("leaves the expensive queries alone across the same cycle", async () => {
    // The reason the global flag was not simply flipped. `recommendations.me`
    // runs the scoring pass and `geoJsonUserList` is metered by Mapbox; paying
    // for both on every glance at the clock is the bill this policy avoids.
    //
    // The first two assertions are what stop this passing vacuously - they
    // establish that the focus event really did reach React Query and really
    // did cause refetching, so the last two are measuring the opt-out rather
    // than an event that went nowhere.
    await renderApp(spies);

    await backgroundAndReturn();

    await waitFor(() => {
      expect(spies.unreadCount).toHaveBeenCalledTimes(2);
      expect(spies.requestsMe).toHaveBeenCalledTimes(2);
    });

    expect(spies.recommendations).toHaveBeenCalledTimes(1);
    expect(spies.geoJsonUserList).toHaveBeenCalledTimes(1);
  });

  it("fires each query once on the initial load, not twice", async () => {
    // The trap in reconciling on a transport event: a handler that invalidates
    // on the *first* connect doubles every query on page load. Nothing may
    // refetch before a real background/foreground transition has happened.
    await renderApp(spies);

    // A settle window: had anything scheduled a second fetch, it would have
    // run by now.
    await act(async () => {
      await Promise.resolve();
    });

    Object.values(spies).forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("does not refetch on the way out, only on the way back", async () => {
    // `focusManager` reports `document.visibilityState !== "hidden"`, and the
    // client acts only when that is true. Backgrounding must cost nothing -
    // otherwise every lock screen fires a round of requests the user will never
    // see the result of.
    await renderApp(spies);

    await act(async () => {
      setVisibility("hidden");
      window.dispatchEvent(new Event("visibilitychange"));
    });

    Object.values(spies).forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("refetches an open thread's pages, the way the conversation query is mounted", async () => {
    // `messages.conversation` is an *infinite* query, which is why it is
    // mounted separately here: the thread is paginated newest-first and
    // `MessageContent` merges the fetched pages with what Pusher appended, so
    // the refetch has to reach the pages, not just the observer.
    const queryClient = new QueryClient({
      defaultOptions: { queries: defaultQueryOptions },
    });
    const conversation = jest.fn(async () => ({
      messages: [],
      nextCursor: undefined as string | undefined,
    }));

    const Thread = () => {
      useInfiniteQuery({
        queryKey: ["conversation"],
        queryFn: conversation,
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        refetchOnMount: "always",
        ...realTimeQueryOptions,
      });
      return null;
    };

    render(
      <QueryClientProvider client={queryClient}>
        <Thread />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(1));

    await backgroundAndReturn();

    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));
  });
});
