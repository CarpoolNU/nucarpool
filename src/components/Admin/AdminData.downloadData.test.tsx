/**
 * SCRUM-540: the "Download Data" button after `buildLineChartCSV` /
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

import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminData from "./AdminData";
import {
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildUserCountsCSV,
} from "../../utils/adminDashboardCsv";

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

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  const asQuery =
    (name: "dateRange" | "stats" | "series") =>
    (input: unknown, options: object) =>
      reactQuery.useQuery({
        queryKey: [name, input],
        queryFn: () => behaviour[name](),
        ...options,
      });

  return {
    trpc: {
      user: {
        admin: {
          getDateRange: { useQuery: asQuery("dateRange") },
          getDashboardStats: { useQuery: asQuery("stats") },
          getDashboardSeries: { useQuery: asQuery("series") },
        },
      },
    },
  };
});

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

const STATS = {
  daysFrequency: {
    riderDayCount: [1, 2, 0, 1, 0, 2, 0],
    driverDayCount: [0, 1, 1, 1, 1, 1, 0],
  },
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
  activeUserCount: [1, 3],
  inactiveUserCount: [0, null],
  groupCounts: [1, 2],
  requestCount: [1, 1],
  driverRequestCount: [1, null],
  riderRequestCount: [0, 1],
};

/** Set fresh per test. */
let behaviour: Record<string, () => Promise<unknown>>;

const resolving = () => ({
  dateRange: async () => ({ minDate: MIN_DATE, maxDate: MAX_DATE }),
  stats: async () => STATS,
  series: async () => SERIES,
});

beforeEach(() => {
  behaviour = resolving();
  mockZipFile.mockClear();
  mockGenerateAsync.mockClear();
  mockSaveAs.mockClear();
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

describe("AdminData's Download Data button", () => {
  it("zips the four CSVs the extracted builders produce for the rendered stats/series", async () => {
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
    expect(mockZipFile).toHaveBeenCalledTimes(4);

    expect(mockSaveAs).toHaveBeenCalledWith(
      "zip-blob-content",
      expect.stringMatching(/^all_data_.*\.zip$/),
    );
  });
});
