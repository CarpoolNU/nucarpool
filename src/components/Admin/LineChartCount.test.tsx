import { render, screen } from "@testing-library/react";
import type { ChartData } from "chart.js";
import LineChartCount from "./LineChartCount";
import { buildLineChartCSV } from "../../utils/adminDashboardCsv";
import { IMPORTED_SIGNUP_DATE_NOTE } from "../../utils/adminDashboardLabels";

/**
 * SCRUM-548: the growth chart and its CSV export used to name their series
 * separately, so the export could go on calling a column "InactiveUserCount"
 * after the chart stopped claiming to know that. This pins the CSV headers to
 * the labels the chart actually hands Chart.js, not to a shared constant, so a
 * label written inline in the component again would fail here.
 *
 * Canvas is unreachable from jsdom, so `Line` is replaced with a stub that
 * records the data it was given.
 */

let rendered: ChartData<"line"> | undefined;

jest.mock("react-chartjs-2", () => ({
  Line: ({ data }: { data: ChartData<"line"> }) => {
    rendered = data;
    return null;
  },
}));

const SERIES = {
  weekLabels: [new Date(2026, 0, 4), new Date(2026, 0, 11)],
  signupCount: [3, 5],
  groupCounts: [0, 1],
  // Every first-week value distinct, so a label fed the wrong series shows.
  requestCount: [9, 12],
  driverRequestCount: [1, 2],
  riderRequestCount: [6, 8],
};

beforeEach(() => {
  rendered = undefined;
});

describe("LineChartCount", () => {
  it("uses exactly the CSV's column headers as its series labels", () => {
    render(<LineChartCount {...SERIES} />);

    const chartLabels = rendered?.datasets.map((dataset) => dataset.label);
    const [, ...csvHeaders] = buildLineChartCSV(SERIES)
      .split("\n")[0]
      .split(",");

    expect(chartLabels).toHaveLength(csvHeaders.length);
    expect([...(chartLabels ?? [])].sort()).toEqual([...csvHeaders].sort());
  });

  it("no longer claims to split users into active and inactive", () => {
    render(<LineChartCount {...SERIES} />);

    const chartLabels = rendered?.datasets.map((dataset) => dataset.label);

    expect(chartLabels).toContain("Users Signed Up");
    expect(chartLabels?.join(" ")).not.toMatch(/active/i);
  });

  it("feeds each label the series of the same name", () => {
    // A matching label set is no use if the data behind a label is another
    // series, so check the pairing the CSV relies on as well.
    render(<LineChartCount {...SERIES} />);

    const byLabel = Object.fromEntries(
      (rendered?.datasets ?? []).map((dataset) => [
        dataset.label,
        dataset.data,
      ]),
    );
    const [header, row] = buildLineChartCSV(SERIES).split("\n");
    const columns = header.split(",");
    const values = row.split(",");

    columns.slice(1).forEach((column, index) => {
      expect(String(byLabel[column][0])).toBe(values[index + 1]);
    });
  });

  it("says that signup dates before the import are not real", () => {
    render(<LineChartCount {...SERIES} />);

    expect(screen.getByText(IMPORTED_SIGNUP_DATE_NOTE)).toBeInTheDocument();
  });
});
