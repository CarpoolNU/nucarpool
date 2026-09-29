import { render, screen } from "@testing-library/react";
import type { ChartData, ChartOptions } from "chart.js";
import BarChartSupplyByCity, {
  NO_DRIVER_AXIS_SUFFIX,
} from "./BarChartSupplyByCity";
import type { AdminSupplyRow } from "../../utils/types";

/**
 * The supply chart's data, and what it does not draw.
 *
 * Canvas is unreachable from jsdom, so `Bar` is replaced with a stub that
 * records the data and options it was given, as `LineChartCount.test.tsx`
 * does for `Line`. That proves what Chart.js is handed - the order of the
 * series, the axis labels, the orientation - and nothing about how it paints.
 */

let rendered:
  { data: ChartData<"bar">; options: ChartOptions<"bar"> } | undefined;

jest.mock("react-chartjs-2", () => ({
  Bar: (props: { data: ChartData<"bar">; options: ChartOptions<"bar"> }) => {
    rendered = props;
    return <canvas data-testid="supply-canvas" />;
  },
}));

const row = (overrides: Partial<AdminSupplyRow>): AdminSupplyRow => ({
  city: "Boston",
  kind: "city",
  drivers: 3,
  riders: 6,
  openSeats: 2,
  ridersPerDriver: 2,
  stranded: false,
  ...overrides,
});

beforeEach(() => {
  rendered = undefined;
});

describe("BarChartSupplyByCity", () => {
  it("draws drivers and then riders, in that order, one bar each per city", () => {
    render(
      <BarChartSupplyByCity
        supplyByCity={[
          row({ city: "Boston", drivers: 3, riders: 6 }),
          row({ city: "Salem", drivers: 1, riders: 4 }),
        ]}
      />,
    );

    expect(rendered?.data.datasets.map((set) => set.label)).toEqual([
      "Drivers",
      "Riders",
    ]);
    expect(rendered?.data.datasets[0].data).toEqual([3, 1]);
    expect(rendered?.data.datasets[1].data).toEqual([6, 4]);
    expect(rendered?.data.labels).toEqual(["Boston", "Salem"]);
  });

  it("is horizontal", () => {
    render(<BarChartSupplyByCity supplyByCity={[row({})]} />);

    expect(rendered?.options.indexAxis).toBe("y");
  });

  it("says in words which city has riders and no driver", () => {
    render(
      <BarChartSupplyByCity
        supplyByCity={[
          row({ city: "Boston" }),
          row({
            city: "Worcester",
            drivers: 0,
            riders: 5,
            ridersPerDriver: null,
            stranded: true,
          }),
        ]}
      />,
    );

    // Only the stranded city carries the words; a city that merely has few
    // drivers does not.
    expect(rendered?.data.labels).toEqual([
      "Boston",
      `Worcester${NO_DRIVER_AXIS_SUFFIX}`,
    ]);
  });

  it("opts out of the total-above-the-bar plugin the user-counts chart registers", () => {
    render(<BarChartSupplyByCity supplyByCity={[row({})]} />);

    // That plugin reads a vertical layout, so on this chart it would draw
    // against the wrong axis. It is registered globally, so the only way to
    // keep it off is for the chart to say so.
    expect(
      (rendered?.options.plugins as Record<string, unknown>).totalLabelPlugin,
    ).toBe(false);
  });

  it("grows with the number of cities and never below the shortest chart", () => {
    const heightOf = (count: number) => {
      const { container, unmount } = render(
        <BarChartSupplyByCity
          supplyByCity={Array.from({ length: count }, (_, i) =>
            row({ city: `City ${i}` }),
          )}
        />,
      );
      const box = container.firstElementChild as HTMLElement;
      const height = parseInt(box.style.height, 10);
      unmount();
      return height;
    };

    expect(heightOf(1)).toBeGreaterThanOrEqual(500);
    expect(heightOf(10)).toBeGreaterThan(heightOf(1));
  });

  it("says so, and draws no chart, when there is no supply to show", () => {
    render(<BarChartSupplyByCity supplyByCity={[]} />);

    expect(screen.queryByTestId("supply-canvas")).not.toBeInTheDocument();
    expect(screen.getByText(/no active drivers or riders yet/i)).toBeVisible();
    expect(rendered).toBeUndefined();
  });
});
