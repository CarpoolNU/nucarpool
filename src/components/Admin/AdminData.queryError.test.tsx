/**
 * Covers that the admin dashboard distinguishes "one of these three
 * failed" from "one of these three has not arrived".
 *
 * `AdminData` fans out to `getDateRange`, `getDashboardStats` and
 * `getDashboardSeries`, destructured for `data` alone, behind a single
 * `return <Spinner />`. `isError` went unread on all three, so any one of them
 * failing was a dashboard that never appeared - and since `adminRouter` throws
 * `UNAUTHORIZED` for `permission === "USER"`, a MANAGER demoting someone out
 * from under their own session got exactly that.
 *
 * The three cases below are the three that used to be one: a failure, a load
 * still in flight, and the settled dashboard. Asserting all three in one file
 * is what keeps the distinction from collapsing back to two.
 *
 * **Real React Query with rejecting `queryFn`s**, per
 * `UserManagement.queryError.test.tsx` - the point is that a rejected fetch
 * reaches the component as the flags it reads, and that retrying a failed query
 * recovers, neither of which a hand-written `isError: true` can show.
 *
 * **The charts are stubbed to markers.** They render through `react-chartjs-2`
 * onto a `<canvas>`, and jsdom implements no 2D context at all - so the
 * settled case would throw on a dependency that has nothing to do with which
 * branch was taken. `AdminPage.test.tsx` stubs the same tree for the same
 * reason.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminData from "./AdminData";
import { trpcSpies, resetTrpcSpies } from "../../testing/trpcHarness";

/** Set per test, one entry per procedure. */
let behaviour: Record<string, () => Promise<unknown>>;

/**
 * The three procedure paths, named once so a count assertion and the mock spec
 * cannot drift apart.
 */
const DATE_RANGE_PATH = "user.admin.getDateRange";
const STATS_PATH = "user.admin.getDashboardStats";
const SERIES_PATH = "user.admin.getDashboardSeries";

/** Fetches the client actually ran, counted from inside it. */
const callCount = (path: string) => trpcSpies(path).queryFn.mock.calls.length;

/**
 * The harness spreads each caller's `options` into the real client, which is
 * what carries the `enabled` gate through - so the series query's hold on
 * `queryRange`, asserted below, is measured rather than assumed.
 */
jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock({
    "user.admin.getDateRange": { query: () => behaviour.dateRange() },
    "user.admin.getDashboardStats": { query: () => behaviour.stats() },
    "user.admin.getDashboardSeries": { query: () => behaviour.series() },
  }),
);

// Inline factories rather than a shared helper: `jest.mock` is hoisted above
// every `const` in the file, so a helper referenced here is not yet defined.
jest.mock("./BarChartUserCounts", () => ({
  __esModule: true,
  default: () => <div>user counts chart</div>,
}));
jest.mock("./LineChartCount", () => ({
  __esModule: true,
  default: () => <div>line chart</div>,
}));
jest.mock("./BarChartDaysFrequency", () => ({
  __esModule: true,
  default: () => <div>days chart</div>,
}));

const MIN_DATE = new Date("2026-01-05T00:00:00Z");
const MAX_DATE = new Date("2026-02-02T00:00:00Z");

/** Every field the settled render destructures, and nothing more. */
const STATS = {
  daysFrequency: {
    riderDayCount: [1, 1, 1, 1, 1, 1, 1],
    driverDayCount: [1, 1, 1, 1, 1, 1, 1],
  },
  conversations: {
    totalConversationCount: 4,
    totalWithMsgCount: 2,
    avgConvWithMsg: 1,
    avgMsg: 3,
  },
  groups: {
    groupCount: 2,
    driversInGroup: 2,
    ridersInGroup: 4,
    totalDrivers: 5,
    totalRiders: 9,
  },
  userCounts: {
    totalAO: 1,
    totalANO: 1,
    totalIO: 1,
    totalINO: 1,
    driverAO: 1,
    driverANO: 1,
    driverIO: 1,
    driverINO: 1,
    riderAO: 1,
    riderANO: 1,
    riderIO: 1,
    riderINO: 1,
    viewerAO: 1,
    viewerANO: 1,
    viewerIO: 1,
    viewerINO: 1,
  },
};

const SERIES = {
  weekLabels: [MIN_DATE],
  signupCount: [1],
  groupCounts: [1],
  requestCount: [1],
  driverRequestCount: [1],
  riderRequestCount: [0],
};

const resolving = () => ({
  dateRange: async () => ({ minDate: MIN_DATE, maxDate: MAX_DATE }),
  stats: async () => STATS,
  series: async () => SERIES,
});

const renderDashboard = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AdminData />
    </QueryClientProvider>,
  );

const spinner = () => screen.queryByText("Loading...");

beforeEach(() => {
  behaviour = resolving();
  resetTrpcSpies();
});

describe("AdminData when a dashboard query fails", () => {
  /**
   * One case per query, because the old guard read `data` from all three and
   * any one of them could hang the page. A fix that only checked the first
   * would pass the `dateRange` row and fail the other two.
   */
  it.each(["dateRange", "stats", "series"] as const)(
    "renders the error treatment when %s fails, with no spinner left",
    async (failing) => {
      behaviour[failing] = async () => {
        throw new Error("UNAUTHORIZED");
      };

      renderDashboard();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("We could not load the dashboard.");
      expect(spinner()).not.toBeInTheDocument();
    },
  );

  it("retries all three, since the reader saw one dashboard not appear", async () => {
    behaviour.stats = async () => {
      throw new Error("boom");
    };

    renderDashboard();
    await screen.findByRole("alert");

    const before = {
      dateRange: callCount(DATE_RANGE_PATH),
      stats: callCount(STATS_PATH),
    };
    behaviour = resolving();

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });

    await waitFor(() =>
      expect(screen.getByText("line chart")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // All three, not just the one that failed - `combineQueryStates.retry`.
    expect(callCount(DATE_RANGE_PATH)).toBeGreaterThan(before.dateRange);
    expect(callCount(STATS_PATH)).toBeGreaterThan(before.stats);
  });

  /**
   * The control, and the mutation test for the cases above: a component
   * rendering `QueryError` unconditionally passes every error assertion and
   * fails this one.
   */
  it("control: resolving queries render the dashboard and no error", async () => {
    renderDashboard();

    await waitFor(() =>
      expect(screen.getByText("Download Data")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(spinner()).not.toBeInTheDocument();
  });

  it("control: shows the spinner while a fetch is still in flight", () => {
    behaviour.stats = () => new Promise(() => undefined);

    renderDashboard();

    expect(spinner()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  /**
   * The case the `hasData` term exists for, and the one most easily broken by
   * counting the series query unconditionally. With an empty database
   * `dateRange` resolves with null bounds, the effect never sets `queryRange`,
   * and the series query stays gated for good - so counting it would be a
   * permanent spinner rather than an empty dashboard.
   */
  it("settles on an empty database, where the series query never runs", async () => {
    behaviour.dateRange = async () => ({ minDate: null, maxDate: null });

    renderDashboard();

    await waitFor(() =>
      expect(screen.getByText("Download Data")).toBeInTheDocument(),
    );
    expect(spinner()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(callCount(SERIES_PATH)).toBe(0);
  });
});
