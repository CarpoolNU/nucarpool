import React, { useEffect, useState } from "react";
import Spinner from "../Spinner";
import { QueryError } from "../QueryError";
import {
  HELD_QUERY_STATE,
  combineQueryStates,
  toQueryState,
} from "../../utils/queryState";
import { trpc } from "../../utils/trpc";
import BarChartUserCounts from "./BarChartUserCounts";
import LineChartCount from "./LineChartCount";
import BarChartDaysFrequency from "./BarChartDaysFrequency";
import QuickStats from "./QuickStats";
import { format, startOfWeek } from "date-fns";
import { ConfigProvider, Slider } from "antd";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import useIsHydrated from "../../utils/useIsHydrated";
import {
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildUserCountsCSV,
} from "../../utils/adminDashboardCsv";

/**
 * The admin dashboard.
 *
 * Every number here is aggregated by `user.admin` on the server.
 * This component used to download the user, group, request, conversation and
 * message tables and reduce them in the browser; it now receives finished
 * counts, so moving the slider narrows the query rather than re-filtering a
 * dataset that was already transferred in full.
 */
function AdminData() {
  // What the slider currently shows, updated continuously while dragging.
  const [sliderRange, setSliderRange] = useState<number[] | null>(null);
  // What the series query asks for, updated only when a drag finishes, so one
  // drag costs one request instead of one per pixel.
  const [queryRange, setQueryRange] = useState<number[] | null>(null);

  /*
   * The same deferral `UserManagement` carries, and here it is precaution
   * rather than a fix.
   *
   * On a phone, `/admin`'s hydration pass renders the desktop dashboard once
   * before `AdminMobileNotice` replaces it, and React Query subscribes in a
   * passive effect that runs before React's corrective re-render - so any
   * query mounted on that pass really goes out and is then discarded. Today
   * this component is not on it: `admin.tsx` defaults `option` to
   * `"management"`, so the pass mounts `UserManagement` and reaching this one
   * takes a sidebar click, by which point hydration is long done and
   * `isHydrated` is already `true`. These three gates are therefore no-ops as
   * the page stands.
   *
   * They are here because the thing keeping them no-ops is a default value.
   * Changing `option`'s default would move three more queries - one of them
   * the dashboard series - onto the discarded pass, silently, with nothing
   * failing. See `UserManagement.tsx` for why the condition carries no
   * viewport term.
   */
  const isHydrated = useIsHydrated();

  const dateRangeQuery = trpc.user.admin.getDateRange.useQuery(undefined, {
    enabled: isHydrated,
  });
  const { data: dateRange } = dateRangeQuery;
  const statsQuery = trpc.user.admin.getDashboardStats.useQuery(undefined, {
    enabled: isHydrated,
  });
  const { data: stats } = statsQuery;
  const seriesQuery = trpc.user.admin.getDashboardSeries.useQuery(
    {
      start: new Date(queryRange?.[0] ?? 0),
      end: new Date(queryRange?.[1] ?? 0),
    },
    { enabled: isHydrated && queryRange !== null },
  );
  const { data: series } = seriesQuery;

  useEffect(() => {
    if (!dateRange?.minDate || !dateRange?.maxDate) {
      return;
    }
    const bounds = [
      startOfWeek(dateRange.minDate).getTime(),
      startOfWeek(dateRange.maxDate).getTime(),
    ];
    setSliderRange(bounds);
    setQueryRange(bounds);
  }, [dateRange]);

  const hasData = !!dateRange?.minDate && !!dateRange?.maxDate;

  /*
   * "One of these three failed" and "one of these three has not arrived" used
   * to be the same spinner, so any failure here was a dashboard that never
   * appeared - and for an ADMIN or MANAGER whose session had lapsed, that was
   * the whole page (SCRUM-509).
   *
   * `combineQueryStates` gives failure priority over loading across all three
   * and retries all three, because from the reader's side this is one
   * dashboard that did not appear rather than three requests.
   *
   * The series query is counted only when there is data to chart. With an
   * empty database `dateRange` resolves with null bounds, the effect above
   * never sets `queryRange`, and the query therefore stays gated for good -
   * counting it would be a permanent load. `HELD_QUERY_STATE` covers the gated
   * spells that *are* temporary, since React Query reads a disabled query as
   * `ready`: the hydration pass for all three, and the wait for the slider
   * bounds for the series.
   */
  const dashboardState = combineQueryStates(
    isHydrated ? toQueryState(dateRangeQuery) : HELD_QUERY_STATE,
    isHydrated ? toQueryState(statsQuery) : HELD_QUERY_STATE,
    ...(hasData
      ? [
          isHydrated && queryRange !== null
            ? toQueryState(seriesQuery)
            : HELD_QUERY_STATE,
        ]
      : []),
  );

  if (dashboardState.status === "error") {
    return (
      <QueryError
        variant="page"
        subject="the dashboard"
        onRetry={dashboardState.retry}
      />
    );
  }

  /*
   * The data checks stay alongside the status, and not only for narrowing:
   * `sliderRange` is local state set by the effect above, so it is one tick
   * behind `dateRange` arriving and is nothing a query state can report.
   */
  if (
    dashboardState.status === "loading" ||
    !dateRange ||
    !stats ||
    (hasData && !sliderRange)
  ) {
    return <Spinner />;
  }

  const [rangeStart, rangeEnd] = sliderRange ?? [0, 0];
  const {
    weekLabels = [],
    signupCount = [],
    groupCounts = [],
    requestCount = [],
    driverRequestCount = [],
    riderRequestCount = [],
  } = series ?? {};

  const { riderDayCount, driverDayCount } = stats.daysFrequency;
  const { totalConversationCount, totalWithMsgCount, avgConvWithMsg, avgMsg } =
    stats.conversations;
  const {
    groupCount,
    driversInGroup,
    ridersInGroup,
    totalDrivers,
    totalRiders,
  } = stats.groups;
  const {
    totalAO,
    totalANO,
    totalIO,
    totalINO,
    driverAO,
    driverANO,
    driverIO,
    driverINO,
    riderAO,
    riderANO,
    riderIO,
    riderINO,
    viewerAO,
    viewerANO,
    viewerIO,
    viewerINO,
  } = stats.userCounts;

  const percent = (part: number, whole: number) =>
    Math.round((part / whole) * 1000) / 10 + "%";
  const percentDriversInGroup = percent(driversInGroup, totalDrivers);
  const percentRidersInGroup = percent(ridersInGroup, totalRiders);
  const averageRidersPerGroup =
    Math.round((ridersInGroup / groupCount) * 10) / 10;

  const formatter = (value: any) => format(new Date(value), "MMM dd, yyyy");

  const handleDownloadData = async () => {
    const zip = new JSZip();
    const dateRaw = new Date().toLocaleDateString();
    const date = dateRaw.replace(/\//g, "_");
    zip.file(`line_chart_${date}.csv`, buildLineChartCSV(series));
    zip.file(`user_counts_${date}.csv`, buildUserCountsCSV(stats.userCounts));
    zip.file(
      `days_frequency_${date}.csv`,
      buildDaysFrequencyCSV(stats.daysFrequency),
    );
    zip.file(
      `quick_stats_${date}.csv`,
      buildQuickStatsCSV({
        totalConversationCount,
        totalWithMsgCount,
        avgConvWithMsg,
        avgMsg,
        groupCount,
        percentDriversInGroup,
        percentRidersInGroup,
        averageRidersPerGroup,
      }),
    );
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, `all_data_${date}.zip`);
  };

  return (
    /*
     * Padding and not a margin, because this box is `h-full` inside a parent
     * that is `overflow-hidden`. It cannot be both: `h-full` makes the scroll
     * port exactly as tall as the content row, and a top margin then pushes it
     * down, so the port's last 16px lands outside the row's clip and is
     * unreachable at *any* scroll position rather than merely below the fold.
     * Measured in Chromium at 16px at 1440x900 and at 667x582 alike, which is
     * the half of SCRUM-484's finding that turned out not to be about small
     * screens at all (SCRUM-488).
     *
     * Padding keeps the same 16px of visual gap - nothing here paints a
     * background, so the two are indistinguishable on screen - and
     * `box-sizing: border-box` charges it to the port's own height instead of
     * to the row's. `ADMIN_DATA_VERTICAL_SPACE_PX` is the 32px it takes out of
     * the row, and the console's height gate is derived from that figure.
     */
    <div className="h-full w-full overflow-y-auto py-4">
      <div className="flex h-full w-full flex-col space-y-4 px-8">
        <button
          onClick={handleDownloadData}
          className="bg-northeastern-red self-start rounded px-4 py-2 font-bold text-white hover:bg-red-700"
        >
          Download Data
        </button>
        <QuickStats
          totalConversationCount={totalConversationCount}
          totalWithMsgCount={totalWithMsgCount}
          avgConvWithMsg={avgConvWithMsg}
          avgMsg={avgMsg}
          groupCount={groupCount}
          percentDriversInGroup={percentDriversInGroup}
          averageRidersPerGroup={averageRidersPerGroup}
          percentRidersInGroup={percentRidersInGroup}
        />
        <BarChartUserCounts
          totalAO={totalAO}
          totalANO={totalANO}
          totalIO={totalIO}
          totalINO={totalINO}
          driverAO={driverAO}
          driverANO={driverANO}
          driverIO={driverIO}
          driverINO={driverINO}
          riderAO={riderAO}
          riderANO={riderANO}
          riderIO={riderIO}
          riderINO={riderINO}
          viewerAO={viewerAO}
          viewerANO={viewerANO}
          viewerIO={viewerIO}
          viewerINO={viewerINO}
        />
        <LineChartCount
          signupCount={signupCount}
          groupCounts={groupCounts}
          requestCount={requestCount}
          driverRequestCount={driverRequestCount}
          riderRequestCount={riderRequestCount}
          weekLabels={weekLabels}
        />
        <div className="w-full">
          <ConfigProvider
            theme={{
              token: {
                fontFamily: "Montserrat",
                fontSize: 16,
                colorPrimary: "#C8102E",
              },
            }}
          >
            <Slider
              range={{ draggableTrack: true }}
              min={
                dateRange.minDate ? startOfWeek(dateRange.minDate).getTime() : 0
              }
              max={
                dateRange.maxDate ? startOfWeek(dateRange.maxDate).getTime() : 0
              }
              value={[rangeStart, rangeEnd]}
              tooltip={{ formatter }}
              onChange={setSliderRange}
              onChangeComplete={setQueryRange}
              step={7 * 24 * 60 * 60 * 1000}
            />
          </ConfigProvider>
          <div className="font-montserrat flex justify-between">
            <span>
              {format(startOfWeek(new Date(rangeStart)), "MMM dd, yyyy")}
            </span>
            <span>
              {format(startOfWeek(new Date(rangeEnd)), "MMM dd, yyyy")}
            </span>
          </div>
        </div>
        <BarChartDaysFrequency
          riderDayCount={riderDayCount}
          driverDayCount={driverDayCount}
        />
      </div>
    </div>
  );
}

export default AdminData;
