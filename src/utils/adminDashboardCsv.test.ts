import {
  buildDaysByWeekdayCSV,
  buildDaysFrequencyCSV,
  buildLineChartCSV,
  buildQuickStatsCSV,
  buildRequestFunnelCSV,
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

describe("buildDaysByWeekdayCSV", () => {
  const days = [
    ["Sunday", 0, 1],
    ["Monday", 4, 9],
    ["Tuesday", 5, 8],
    ["Wednesday", 3, 0],
    ["Thursday", 2, 6],
    ["Friday", 1, 7],
    ["Saturday", 0, 0],
  ] as const;

  const daysByWeekday: AdminDashboardStats["daysByWeekday"] = {
    days: days.map(([day, drivers, riders]) => ({
      day,
      drivers,
      riders,
      stranded: riders > 0 && drivers === 0,
    })),
    unspecified: { drivers: 2, riders: 5 },
  };

  it("emits the header, seven days Sunday first, and then Unspecified", () => {
    expect(buildDaysByWeekdayCSV(daysByWeekday).split("\n")).toEqual([
      "Day,Drivers,Riders,No Driver",
      "Sunday,0,1,Yes",
      "Monday,4,9,No",
      "Tuesday,5,8,No",
      "Wednesday,3,0,No",
      "Thursday,2,6,No",
      "Friday,1,7,No",
      "Saturday,0,0,No",
      "Unspecified,2,5,",
    ]);
  });

  it("puts drivers before riders, the order the chart and the table use", () => {
    const rows = buildDaysByWeekdayCSV(daysByWeekday).split("\n");

    expect(rows[0]).toBe("Day,Drivers,Riders,No Driver");
    expect(rows[2]).toBe("Monday,4,9,No");
  });

  it("still lists every day and Unspecified for an empty platform", () => {
    const rows = buildDaysByWeekdayCSV({
      days: daysByWeekday.days.map((row) => ({
        ...row,
        drivers: 0,
        riders: 0,
        stranded: false,
      })),
      unspecified: { drivers: 0, riders: 0 },
    }).split("\n");

    expect(rows).toHaveLength(9);
    expect(rows[8]).toBe("Unspecified,0,0,");
  });

  it("carries no time of day, in a header or a field", () => {
    expect(buildDaysByWeekdayCSV(daysByWeekday)).not.toMatch(
      /\d:\d\d|\b(am|pm)\b|hour|time/i,
    );
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

describe("buildRequestFunnelCSV", () => {
  it("emits a header and one row per stage, rating each against the one before", () => {
    expect(
      buildRequestFunnelCSV({
        requestsSent: 200,
        requestsAccepted: 50,
        ridersInGroup: 25,
      }).split("\n"),
    ).toEqual([
      "Stage,Count (current state),PercentOfPreviousStage",
      "Requests sent,200,",
      "Requests accepted,50,25%",
      "Riders in a group,25,50%",
    ]);
  });

  it("names the count column as a snapshot, since a spreadsheet carries no caption", () => {
    const [header] = buildRequestFunnelCSV({
      requestsSent: 0,
      requestsAccepted: 0,
      ridersInGroup: 0,
    }).split("\n");

    expect(header).toContain("current state");
  });

  it("leaves every rate blank for an empty platform instead of writing NaN", () => {
    const csv = buildRequestFunnelCSV({
      requestsSent: 0,
      requestsAccepted: 0,
      ridersInGroup: 0,
    });

    expect(csv).not.toMatch(/NaN|Infinity/);
    expect(csv.split("\n").slice(1)).toEqual([
      "Requests sent,0,",
      "Requests accepted,0,",
      "Riders in a group,0,",
    ]);
  });

  it("writes the real count but no rate for a stage larger than the one before it", () => {
    // A rider in a group whose request row was erased.
    expect(
      buildRequestFunnelCSV({
        requestsSent: 1,
        requestsAccepted: 0,
        ridersInGroup: 1,
      }).split("\n"),
    ).toEqual([
      "Stage,Count (current state),PercentOfPreviousStage",
      "Requests sent,1,",
      "Requests accepted,0,0%",
      "Riders in a group,1,",
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
