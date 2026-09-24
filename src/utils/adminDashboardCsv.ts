import { format } from "date-fns";
import { LINE_CHART_LABELS } from "./adminDashboardLabels";
import { AdminDashboardSeries, AdminDashboardStats } from "./types";

/**
 * CSV formatting for the admin dashboard export (SCRUM-540).
 *
 * Privacy decision, recorded per the ticket's acceptance criteria: every
 * column below comes straight from `user.admin.getDashboardStats` /
 * `getDashboardSeries` — the exact aggregates `AdminData` already renders on
 * screen. No individual-level or PII column is included, and none of these
 * functions accepts one; that keeps the export bound to the same
 * "aggregates, not tables" guarantee `admin.ts` documents for the router
 * itself, rather than relying on call sites to remember not to pass one in.
 *
 * Pulled out of `AdminData.tsx` so this formatting logic is unit-testable
 * without rendering the component, matching the pattern `adminDataUtils.ts`
 * already sets for the aggregation this consumes.
 */

export function buildLineChartCSV(
  series: AdminDashboardSeries | undefined,
): string {
  const {
    weekLabels = [],
    signupCount = [],
    groupCounts = [],
    requestCount = [],
    driverRequestCount = [],
    riderRequestCount = [],
  } = series ?? {};

  // The chart's own legend labels, so a column is named for what the chart
  // says it is rather than for a series that no longer exists.
  const headers = [
    "Date",
    LINE_CHART_LABELS.signupCount,
    LINE_CHART_LABELS.groupCounts,
    LINE_CHART_LABELS.requestCount,
    LINE_CHART_LABELS.driverRequestCount,
    LINE_CHART_LABELS.riderRequestCount,
  ];
  const csvRows = [headers.join(",")];

  weekLabels.forEach((dateLabel, index) => {
    const row = [
      format(dateLabel, "MMM dd yyyy"),
      signupCount[index] ?? "",
      groupCounts[index] ?? "",
      requestCount[index] ?? "",
      driverRequestCount[index] ?? "",
      riderRequestCount[index] ?? "",
    ];
    csvRows.push(row.join(","));
  });

  return csvRows.join("\n");
}

export function buildUserCountsCSV(
  userCounts: AdminDashboardStats["userCounts"],
): string {
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
  } = userCounts;

  const headers = [
    "Type",
    "Active Onboarded",
    "Active Not Onboarded",
    "Inactive Onboarded",
    "Inactive Not Onboarded",
  ];
  const csvRows = [headers.join(",")];

  csvRows.push(["Total", totalAO, totalANO, totalIO, totalINO].join(","));
  csvRows.push(["Driver", driverAO, driverANO, driverIO, driverINO].join(","));
  csvRows.push(["Rider", riderAO, riderANO, riderIO, riderINO].join(","));
  csvRows.push(["Viewer", viewerAO, viewerANO, viewerIO, viewerINO].join(","));

  return csvRows.join("\n");
}

export function buildDaysFrequencyCSV(
  daysFrequency: AdminDashboardStats["daysFrequency"],
): string {
  const { riderDayCount, driverDayCount } = daysFrequency;
  const headers = ["Day", "RiderCount", "DriverCount"];
  const csvRows = [headers.join(",")];
  const days = ["Su", "M", "Tu", "W", "Th", "F", "S"];

  days.forEach((day, i) => {
    csvRows.push(
      [day, riderDayCount[i] ?? "", driverDayCount[i] ?? ""].join(","),
    );
  });

  return csvRows.join("\n");
}

/**
 * The two percentages and the average are computed by `AdminData` from
 * `stats.groups`, not returned by the router as-is, so this takes the
 * already-derived values rather than recomputing them a second way.
 */
export interface QuickStatsCSVInput {
  totalConversationCount: number;
  totalWithMsgCount: number;
  avgConvWithMsg: number;
  avgMsg: number;
  groupCount: number;
  percentDriversInGroup: string;
  percentRidersInGroup: string;
  averageRidersPerGroup: number;
}

export function buildQuickStatsCSV(input: QuickStatsCSVInput): string {
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
    input.totalConversationCount,
    input.totalWithMsgCount,
    input.avgConvWithMsg,
    input.avgMsg,
    input.groupCount,
    input.percentDriversInGroup,
    input.percentRidersInGroup,
    input.averageRidersPerGroup,
  ].join(",");

  return [headers.join(","), row].join("\n");
}
