/**
 * `AdminData`: which of the three dashboard queries failed, and what the
 * Download Data button zips once they have all settled.
 *
 * Two tickets, one per `describe` block, which were two sibling files until the
 * setup they shared outgrew the reason for the split - identical `trpcHarness`
 * spec, identical chart stubs, identical client and identical `renderDashboard`.
 * Neither of the mandatory split reasons in `CLAUDE.md` applied.
 *
 * **One fixture pair serves both blocks, and it is the download test's.** That
 * one varies field to field, which the CSV assertions need: against an all-ones
 * `STATS` a builder that transposed two columns would still match. The error
 * assertions only ask which of spinner, alert and dashboard is on screen, so
 * they are indifferent to the values - which is why the richer pair is the one
 * that survives rather than the other way round.
 *
 * ---
 *
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
import {
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildSupplyByCityCSV,
  buildUserCountsCSV,
} from "../../utils/adminDashboardCsv";
import type { AdminSupplyRow } from "../../utils/types";

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
const mockZipFile = jest.fn();
const mockGenerateAsync = jest.fn().mockResolvedValue("zip-blob-content");
jest.mock("jszip", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    file: mockZipFile,
    generateAsync: mockGenerateAsync,
  })),
}));

const mockSaveAs = jest.fn();
jest.mock("file-saver", () => ({
  __esModule: true,
  saveAs: (...args: unknown[]) => mockSaveAs(...args),
}));

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
// The supply chart's stub says how many rows it was handed, so the wiring from
// `stats.supplyByCity` is measured and not only that a chart exists.
jest.mock("./BarChartSupplyByCity", () => ({
  __esModule: true,
  default: ({ supplyByCity }: { supplyByCity: unknown[] }) => (
    <div>supply chart with {supplyByCity.length} rows</div>
  ),
}));
jest.mock("./SupplyByCityTable", () => ({
  __esModule: true,
  default: ({ supplyByCity }: { supplyByCity: unknown[] }) => (
    <div>supply table with {supplyByCity.length} rows</div>
  ),
}));

const MIN_DATE = new Date("2026-01-05T00:00:00Z");
const MAX_DATE = new Date("2026-02-02T00:00:00Z");

/** Every field the settled render destructures, and nothing more. */
const STATS = {
  daysFrequency: {
    riderDayCount: [1, 2, 0, 1, 0, 2, 0],
    driverDayCount: [0, 1, 1, 1, 1, 1, 0],
  },
  // Every column distinct, and one stranded city with no ratio, so an export
  // that transposed two columns or wrote the missing ratio as text would differ.
  supplyByCity: [
    {
      city: "Boston",
      kind: "city",
      drivers: 3,
      riders: 7,
      openSeats: 5,
      ridersPerDriver: 2.3,
      stranded: false,
    },
    {
      city: "Worcester",
      kind: "city",
      drivers: 0,
      riders: 2,
      openSeats: 0,
      ridersPerDriver: null,
      stranded: true,
    },
  ] satisfies AdminSupplyRow[],
  conversations: {
    totalConversationCount: 4,
    totalWithMsgCount: 2,
    avgConvWithMsg: 1.5,
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
    totalAO: 3,
    totalANO: 1,
    totalIO: 1,
    totalINO: 1,
    driverAO: 2,
    driverANO: 0,
    driverIO: 1,
    driverINO: 0,
    riderAO: 1,
    riderANO: 1,
    riderIO: 0,
    riderINO: 1,
    viewerAO: 0,
    viewerANO: 0,
    viewerIO: 0,
    viewerINO: 0,
  },
};

const SERIES = {
  weekLabels: [MIN_DATE, MAX_DATE],
  signupCount: [1, 3],
  groupCounts: [1, 2],
  requestCount: [1, 1],
  driverRequestCount: [1, null],
  riderRequestCount: [0, 1],
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
  mockZipFile.mockClear();
  mockGenerateAsync.mockClear();
  mockSaveAs.mockClear();
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

  it("hands the supply chart and its table the rows `getDashboardStats` returned", async () => {
    renderDashboard();

    expect(
      await screen.findByText("supply chart with 2 rows"),
    ).toBeInTheDocument();
    expect(screen.getByText("supply table with 2 rows")).toBeInTheDocument();
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

/**
 * The "Download Data" button, after `buildLineChartCSV` /
 * `buildUserCountsCSV` / `buildDaysFrequencyCSV` / `buildQuickStatsCSV` moved
 * out of `AdminData` into `../../utils/adminDashboardCsv`, so they are
 * unit-testable on their own (see `adminDashboardCsv.test.ts`).
 *
 * That move is a behaviour-preserving refactor only if the button still zips
 * the same four CSVs from the same rendered `stats`/`series`. This renders
 * the real component against mocked queries (same harness as
 * `AdminData.queryError.test.tsx`), clicks the button, and checks each
 * `zip.file(...)` call against the same builder functions called directly on
 * the fixture — proving the wiring, not the formatting logic, which is
 * already covered elsewhere.
 */
describe("AdminData's Download Data button", () => {
  it("zips the five CSVs the extracted builders produce for the rendered stats/series", async () => {
    renderDashboard();

    const button = await screen.findByRole("button", {
      name: "Download Data",
    });

    await act(async () => {
      button.click();
    });

    await waitFor(() => expect(mockSaveAs).toHaveBeenCalledTimes(1));

    const percent = (part: number, whole: number) =>
      Math.round((part / whole) * 1000) / 10 + "%";
    const expectedQuickStatsCSV = buildQuickStatsCSV({
      totalConversationCount: STATS.conversations.totalConversationCount,
      totalWithMsgCount: STATS.conversations.totalWithMsgCount,
      avgConvWithMsg: STATS.conversations.avgConvWithMsg,
      avgMsg: STATS.conversations.avgMsg,
      groupCount: STATS.groups.groupCount,
      percentDriversInGroup: percent(
        STATS.groups.driversInGroup,
        STATS.groups.totalDrivers,
      ),
      percentRidersInGroup: percent(
        STATS.groups.ridersInGroup,
        STATS.groups.totalRiders,
      ),
      averageRidersPerGroup:
        Math.round(
          (STATS.groups.ridersInGroup / STATS.groups.groupCount) * 10,
        ) / 10,
    });

    expect(mockZipFile).toHaveBeenCalledWith(
      expect.stringMatching(/^line_chart_.*\.csv$/),
      buildLineChartCSV(SERIES),
    );
    expect(mockZipFile).toHaveBeenCalledWith(
      expect.stringMatching(/^user_counts_.*\.csv$/),
      buildUserCountsCSV(STATS.userCounts),
    );
    expect(mockZipFile).toHaveBeenCalledWith(
      expect.stringMatching(/^days_frequency_.*\.csv$/),
      buildDaysFrequencyCSV(STATS.daysFrequency),
    );
    expect(mockZipFile).toHaveBeenCalledWith(
      expect.stringMatching(/^quick_stats_.*\.csv$/),
      expectedQuickStatsCSV,
    );
    expect(mockZipFile).toHaveBeenCalledWith(
      expect.stringMatching(/^supply_by_city_.*\.csv$/),
      buildSupplyByCityCSV(STATS.supplyByCity),
    );
    expect(mockZipFile).toHaveBeenCalledTimes(5);

    expect(mockSaveAs).toHaveBeenCalledWith(
      "zip-blob-content",
      expect.stringMatching(/^all_data_.*\.zip$/),
    );
  });
});
