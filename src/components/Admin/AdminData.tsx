import React, { useEffect, useState } from "react";
import Spinner from "../Spinner";
import { trpc } from "../../utils/trpc";
import BarChartUserCounts from "./BarChartUserCounts";
import LineChartCount from "./LineChartCount";
import BarChartDaysFrequency from "./BarChartDaysFrequency";
import QuickStats from "./QuickStats";
import { format, startOfWeek } from "date-fns";
import { ConfigProvider, Slider } from "antd";
import JSZip from "jszip";
import { saveAs } from "file-saver";

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

  const { data: dateRange } = trpc.user.admin.getDateRange.useQuery();
  const { data: stats } = trpc.user.admin.getDashboardStats.useQuery();
  const { data: series } = trpc.user.admin.getDashboardSeries.useQuery(
    {
      start: new Date(queryRange?.[0] ?? 0),
      end: new Date(queryRange?.[1] ?? 0),
    },
    { enabled: queryRange !== null },
  );

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

  if (!dateRange || !stats || (hasData && (!sliderRange || !series))) {
    return <Spinner />;
  }

  const [rangeStart, rangeEnd] = sliderRange ?? [0, 0];
  const {
    weekLabels = [],
    activeUserCount = [],
    inactiveUserCount = [],
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

  // line chart
  const buildLineChartCSV = () => {
    const headers = [
      "Date",
      "ActiveUserCount",
      "InactiveUserCount",
      "GroupCounts",
      "RequestCount",
      "DriverRequestCount",
      "RiderRequestCount",
    ];
    const csvRows = [headers.join(",")];

    weekLabels.forEach((dateLabel, index) => {
      const row = [
        format(dateLabel, "MMM dd yyyy"),
        activeUserCount[index] ?? "",
        inactiveUserCount[index] ?? "",
        groupCounts[index] ?? "",
        requestCount[index] ?? "",
        driverRequestCount[index] ?? "",
        riderRequestCount[index] ?? "",
      ];
      csvRows.push(row.join(","));
    });

    return csvRows.join("\n");
  };

  // user counts
  const buildUserCountsCSV = () => {
    const headers = [
      "Type",
      "Active Onboarded",
      "Active Not Onboarded",
      "Inactive Onboarded",
      "Inactive Not Onboarded",
    ];
    const csvRows = [headers.join(",")];

    csvRows.push(["Total", totalAO, totalANO, totalIO, totalINO].join(","));
    csvRows.push(
      ["Driver", driverAO, driverANO, driverIO, driverINO].join(","),
    );
    csvRows.push(["Rider", riderAO, riderANO, riderIO, riderINO].join(","));
    csvRows.push(
      ["Viewer", viewerAO, viewerANO, viewerIO, viewerINO].join(","),
    );

    return csvRows.join("\n");
  };

  // days frequency
  const buildDaysFrequencyCSV = () => {
    const headers = ["Day", "RiderCount", "DriverCount"];
    const csvRows = [headers.join(",")];
    const days = ["Su", "M", "Tu", "W", "Th", "F", "S"];

    days.forEach((day, i) => {
      csvRows.push(
        [day, riderDayCount[i] ?? "", driverDayCount[i] ?? ""].join(","),
      );
    });

    return csvRows.join("\n");
  };

  // quick stats
  const buildQuickStatsCSV = () => {
    const headers = [
      "Total Conversations",
      "Total Conversations With > 1 Message",
      "Avg Messages Per Conversation with > 1 Message",
      "Avg Messages",
      "Total Groups",
      "PercentDriversInGroup",
      "PercentRidersInGroup",
      "AverageRidersPerGroup",
    ];

    const row = [
      totalConversationCount,
      totalWithMsgCount,
      avgConvWithMsg,
      avgMsg,
      groupCount,
      percentDriversInGroup,
      percentRidersInGroup,
      averageRidersPerGroup,
    ].join(",");

    return [headers.join(","), row].join("\n");
  };

  const handleDownloadData = async () => {
    const zip = new JSZip();
    const dateRaw = new Date().toLocaleDateString();
    const date = dateRaw.replace(/\//g, "_");
    zip.file(`line_chart_${date}.csv`, buildLineChartCSV());
    zip.file(`user_counts_${date}.csv`, buildUserCountsCSV());
    zip.file(`days_frequency_${date}.csv`, buildDaysFrequencyCSV());
    zip.file(`quick_stats_${date}.csv`, buildQuickStatsCSV());
    const content = await zip.generateAsync({ type: "blob" });
    saveAs(content, `all_data_${date}.zip`);
  };

  return (
    <div className="my-4 h-full w-full overflow-y-auto">
      <div className="flex h-full w-full flex-col space-y-4 px-8">
        <button
          onClick={handleDownloadData}
          className="self-start rounded bg-northeastern-red px-4 py-2 font-bold text-white hover:bg-red-700"
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
          activeUserCount={activeUserCount}
          inactiveUserCount={inactiveUserCount}
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
          <div className="flex justify-between font-montserrat">
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
