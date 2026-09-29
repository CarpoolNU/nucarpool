import {
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildSupplyByCityCSV,
  buildUserCountsCSV,
  csvTextField,
} from "./adminDashboardCsv";
import { AdminDashboardStats } from "./types";

/**
 * CSV formatting for the admin dashboard export.
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

describe("csvTextField", () => {
  it("leaves an ordinary name alone", () => {
    expect(csvTextField("Boston")).toBe("Boston");
  });

  it("quotes a comma so it cannot open a new column", () => {
    expect(csvTextField("Boston, MA")).toBe('"Boston, MA"');
  });

  it("doubles a quote inside the quoted field", () => {
    expect(csvTextField('The "Hub"')).toBe('"The ""Hub"""');
  });

  it("quotes a line break so it cannot open a new row", () => {
    expect(csvTextField("Bos\nton")).toBe('"Bos\nton"');
    expect(csvTextField("Bos\rton")).toBe('"Bos\rton"');
  });

  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tcmd", "\rcmd"])(
    "defuses %j, which a spreadsheet would read as a formula",
    (value) => {
      expect(csvTextField(value).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("defuses and quotes a field that needs both", () => {
    expect(csvTextField('=HYPERLINK("x","y")')).toBe(
      '"\'=HYPERLINK(""x"",""y"")"',
    );
  });

  it("does not touch a dash or equals sign that is not leading", () => {
    expect(csvTextField("Winston-Salem")).toBe("Winston-Salem");
  });
});

describe("buildSupplyByCityCSV", () => {
  it("emits only the header for an empty platform", () => {
    expect(buildSupplyByCityCSV([])).toBe(
      "City,Drivers,Riders,Open Seats,Riders Per Driver,No Driver",
    );
  });

  it("emits one row per bucket, in the order it was given", () => {
    expect(
      buildSupplyByCityCSV([
        {
          city: "Boston",
          kind: "city",
          drivers: 3,
          riders: 10,
          openSeats: 4,
          ridersPerDriver: 3.3,
          stranded: false,
        },
        {
          city: "Worcester",
          kind: "city",
          drivers: 0,
          riders: 5,
          openSeats: 0,
          ridersPerDriver: null,
          stranded: true,
        },
        {
          city: "Other",
          kind: "other",
          drivers: 1,
          riders: 0,
          openSeats: 2,
          ridersPerDriver: 0,
          stranded: false,
        },
      ]),
    ).toBe(
      [
        "City,Drivers,Riders,Open Seats,Riders Per Driver,No Driver",
        "Boston,3,10,4,3.3,No",
        // No driver: the ratio cell is empty, never "Infinity" or "null".
        "Worcester,0,5,0,,Yes",
        // A real zero is written as 0, unlike the missing ratio above.
        "Other,1,0,2,0,No",
      ].join("\n"),
    );
  });

  it("escapes the city, so a name cannot add a column", () => {
    const [, row] = buildSupplyByCityCSV([
      {
        city: "Boston, MA",
        kind: "city",
        drivers: 1,
        riders: 1,
        openSeats: 0,
        ridersPerDriver: 1,
        stranded: false,
      },
    ]).split("\n");

    expect(row).toBe('"Boston, MA",1,1,0,1,No');
  });
});
