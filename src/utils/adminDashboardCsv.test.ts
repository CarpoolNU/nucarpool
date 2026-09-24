import {
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildUserCountsCSV,
} from "./adminDashboardCsv";
import { AdminDashboardStats } from "./types";

/**
 * CSV formatting for the SCRUM-540 admin dashboard export.
 *
 * These assert on the exact strings `AdminData`'s "Download Data" button
 * zips up, since that is what an admin actually opens in a spreadsheet —
 * a wrong header order or a dropped `?? ""` fallback would only be visible
 * there, not in `getDashboardStats`/`getDashboardSeries`'s own tests.
 */

const userCounts: AdminDashboardStats["userCounts"] = {
  totalAO: 10,
  totalANO: 1,
  totalIO: 2,
  totalINO: 3,
  driverAO: 4,
  driverANO: 0,
  driverIO: 1,
  driverINO: 0,
  riderAO: 5,
  riderANO: 1,
  riderIO: 1,
  riderINO: 0,
  viewerAO: 1,
  viewerANO: 0,
  viewerIO: 0,
  viewerINO: 3,
};

describe("buildLineChartCSV", () => {
  it("emits one header row and no data rows for an empty series", () => {
    expect(buildLineChartCSV(undefined)).toBe(
      "Date,Users Signed Up,Groups,Requests,Requests From Current Drivers,Requests From Current Riders",
    );
  });

  it("formats each week label and lines up every column by index", () => {
    const csv = buildLineChartCSV({
      weekLabels: [new Date(2026, 0, 4), new Date(2026, 0, 11)],
      signupCount: [3, 5],
      groupCounts: [0, 1],
      requestCount: [2, 4],
      driverRequestCount: [1, 2],
      riderRequestCount: [1, 2],
    });

    const rows = csv.split("\n");
    expect(rows[0]).toBe(
      "Date,Users Signed Up,Groups,Requests,Requests From Current Drivers,Requests From Current Riders",
    );
    expect(rows[1]).toBe("Jan 04 2026,3,0,2,1,1");
    expect(rows[2]).toBe("Jan 11 2026,5,1,4,2,2");
  });

  it("renders a null bucket as an empty field rather than the literal 'null'", () => {
    const csv = buildLineChartCSV({
      weekLabels: [new Date(2026, 0, 4)],
      signupCount: [null],
      groupCounts: [null],
      requestCount: [null],
      driverRequestCount: [null],
      riderRequestCount: [null],
    });

    expect(csv.split("\n")[1]).toBe("Jan 04 2026,,,,,");
  });
});

describe("buildUserCountsCSV", () => {
  it("emits the header and one row per role in a fixed order", () => {
    const rows = buildUserCountsCSV(userCounts).split("\n");

    expect(rows).toEqual([
      "Type,Active Onboarded,Active Not Onboarded,Inactive Onboarded,Inactive Not Onboarded",
      "Total,10,1,2,3",
      "Driver,4,0,1,0",
      "Rider,5,1,1,0",
      "Viewer,1,0,0,3",
    ]);
  });
});

describe("buildDaysFrequencyCSV", () => {
  it("emits one row per day, Sunday first, matching the day-index arrays", () => {
    const rows = buildDaysFrequencyCSV({
      riderDayCount: [1, 2, 3, 4, 5, 6, 7],
      driverDayCount: [7, 6, 5, 4, 3, 2, 1],
    }).split("\n");

    expect(rows).toEqual([
      "Day,RiderCount,DriverCount",
      "Su,1,7",
      "M,2,6",
      "Tu,3,5",
      "W,4,4",
      "Th,5,3",
      "F,6,2",
      "S,7,1",
    ]);
  });

  it("falls back to an empty field for a day index the arrays do not cover", () => {
    const rows = buildDaysFrequencyCSV({
      riderDayCount: [1],
      driverDayCount: [],
    }).split("\n");

    expect(rows[1]).toBe("Su,1,");
    expect(rows[2]).toBe("M,,");
  });
});

describe("buildQuickStatsCSV", () => {
  it("emits the header and exactly one row, in argument order", () => {
    const csv = buildQuickStatsCSV({
      totalConversationCount: 42,
      totalWithMsgCount: 30,
      avgConvWithMsg: 4.5,
      avgMsg: 3.2,
      groupCount: 8,
      percentDriversInGroup: "75%",
      percentRidersInGroup: "60%",
      averageRidersPerGroup: 2.1,
    });

    expect(csv.split("\n")).toEqual([
      "Total Conversations,Total Conversations With > 1 Message,Avg Messages Per Conversation with > 1 Message,Avg Messages,Total Groups,PercentDriversInGroup,PercentRidersInGroup,AverageRidersPerGroup",
      "42,30,4.5,3.2,8,75%,60%,2.1",
    ]);
  });
});
