/**
 * SCRUM-561 item 3: a filter the user set on the explore page has to survive a
 * `user.me` refetch.
 *
 * The seeding effect in `pages/index.tsx` was keyed on `[user]`, and every
 * refetch returns a new object - superjson rebuilds the dates, too - so
 * accepting a request, leaving a group or saving group preferences, each of
 * which invalidates `user.me`, wrote the profile's days and dates back over
 * the filter panel.
 *
 * **Real React Query.** `Harness` holds `user.me` as a live query whose
 * `queryFn` returns a freshly built object on every call, which is exactly
 * what makes the identity change, and the "accept" below is the invalidation
 * that accepting a request performs. The page itself is not mounted: it is the
 * Mapbox map, Pusher and a dozen queries, and the subject is this one effect.
 */

import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { FiltersState, User } from "../types";
import { useProfileFilterSeed } from "./useProfileFilterSeed";

type Profile = Pick<
  User,
  "role" | "coopStartDate" | "coopEndDate" | "daysWorking"
>;

/** The stored profile. Each fetch builds new objects from it. */
let stored = {
  role: "RIDER" as Profile["role"],
  start: "2026-01-05T00:00:00.000Z",
  end: "2026-06-30T00:00:00.000Z",
  daysWorking: "0,1,1,1,1,1,0",
};

/**
 * `fetch` numbers each response so a test can wait until a refetch has
 * actually been rendered. React Query v5 notifies observers on a
 * `setTimeout(0)`, so an awaited `invalidateQueries` returns before the
 * component sees the new object - and an assertion made then passes whatever
 * the hook does with it.
 */
let fetches = 0;
const userQueryFn = jest.fn(async (): Promise<Profile & { fetch: number }> => ({
  role: stored.role,
  coopStartDate: new Date(stored.start),
  coopEndDate: new Date(stored.end),
  daysWorking: stored.daysWorking,
  fetch: ++fetches,
}));

const INITIAL_FILTERS: FiltersState = {
  days: 0,
  flexDays: 1,
  startDistance: 20,
  endDistance: 20,
  daysWorking: "",
  startTime: 4,
  endTime: 4,
  startDate: new Date("2020-01-01T00:00:00.000Z"),
  endDate: new Date("2020-01-01T00:00:00.000Z"),
  dateOverlap: 0,
  favorites: false,
  messaged: false,
};

const CUSTOM_DAYS = "1,0,0,0,0,0,1";

const Harness = () => {
  const { data: user } = useQuery({
    queryKey: ["user.me"],
    queryFn: userQueryFn,
  });
  const [filters, setFilters] = useState<FiltersState>(INITIAL_FILTERS);
  useProfileFilterSeed(user, setFilters);
  return (
    <>
      <output data-testid="fetch">{user?.fetch}</output>
      <output data-testid="days">{filters.daysWorking}</output>
      <output data-testid="start">{filters.startDate.toISOString()}</output>
      <button
        onClick={() =>
          setFilters((prev) => ({ ...prev, daysWorking: CUSTOM_DAYS }))
        }
      >
        Pick custom days
      </button>
    </>
  );
};

const days = () => screen.getByTestId("days");
const start = () => screen.getByTestId("start");

let queryClient: QueryClient;

const renderSeeded = async () => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(days()).toHaveTextContent(stored.daysWorking));
};

/** What accepting a request does to `user.me`, and the refetch it causes. */
const refetchUserMe = async () => {
  const next = String(fetches + 1);
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["user.me"] });
  });
  // The barrier: the refetched object has reached the component.
  await waitFor(() =>
    expect(screen.getByTestId("fetch").textContent).toBe(next),
  );
};

beforeEach(() => {
  userQueryFn.mockClear();
  fetches = 0;
  stored = {
    role: "RIDER",
    start: "2026-01-05T00:00:00.000Z",
    end: "2026-06-30T00:00:00.000Z",
    daysWorking: "0,1,1,1,1,1,0",
  };
});

describe("useProfileFilterSeed", () => {
  it("keeps a custom day filter through a user.me refetch", async () => {
    await renderSeeded();

    fireEvent.click(screen.getByRole("button", { name: "Pick custom days" }));
    expect(days()).toHaveTextContent(CUSTOM_DAYS);

    await refetchUserMe();

    expect(days()).toHaveTextContent(CUSTOM_DAYS);
  });

  it("control: seeds the filters from the profile when it loads", async () => {
    await renderSeeded();

    expect(days()).toHaveTextContent("0,1,1,1,1,1,0");
    expect(start()).toHaveTextContent("2026-01-05T00:00:00.000Z");
  });

  /**
   * The fix must not freeze the seed: a profile that really changed still
   * reaches the filters. A hook that seeded exactly once would pass the first
   * case and fail this.
   */
  it("control: re-seeds when the stored profile genuinely changes", async () => {
    await renderSeeded();
    fireEvent.click(screen.getByRole("button", { name: "Pick custom days" }));

    stored = { ...stored, daysWorking: "0,0,1,1,1,0,0" };
    await refetchUserMe();

    await waitFor(() => expect(days()).toHaveTextContent("0,0,1,1,1,0,0"));
  });

  it("control: leaves a VIEWER's filters at their defaults", async () => {
    stored = { ...stored, role: "VIEWER" };
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(queryClient.getQueryData(["user.me"])).toBeDefined(),
    );
    // Let the effects the loaded profile schedules run before asserting.
    await act(async () => {});
    // `toHaveTextContent("")` matches any text at all, so compare exactly.
    expect(days().textContent).toBe("");
    expect(start()).toHaveTextContent("2020-01-01T00:00:00.000Z");
  });
});
