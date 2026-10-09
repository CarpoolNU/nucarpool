import { render, screen } from "@testing-library/react";
import type { ChartData, ChartOptions } from "chart.js";
import BarChartDaysByWeekday, {
  NO_DRIVER_DAY_SUFFIX,
} from "./BarChartDaysByWeekday";
import { WEEKDAY_NAMES } from "../../utils/adminDashboardLabels";
import type { AdminDaysByWeekday } from "../../utils/types";

/**
 * The day-of-week chart's data, and what it does not draw.
 *
 * Canvas is unreachable from jsdom, so `Bar` is replaced with a stub that
 * records the data and options it was given, as `BarChartSupplyByCity.test.tsx`
 * does. That proves what Chart.js is handed - the order of the series, which
 * count sits under which day - and nothing about how it paints.
 */

let rendered:
  { data: ChartData<"bar">; options: ChartOptions<"bar"> } | undefined;

jest.mock("react-chartjs-2", () => ({
  Bar: (props: { data: ChartData<"bar">; options: ChartOptions<"bar"> }) => {
    rendered = props;
    return <canvas data-testid="weekday-canvas" />;
  },
}));

/** Every column distinct, so a transposed pair of days or series would differ. */
const DRIVERS = [0, 4, 5, 3, 2, 1, 0];
const RIDERS = [1, 9, 8, 0, 6, 7, 0];

const daysByWeekday = (
  overrides: Partial<AdminDaysByWeekday> = {},
): AdminDaysByWeekday => ({
  days: WEEKDAY_NAMES.map((day, index) => ({
    day,
    drivers: DRIVERS[index],
    riders: RIDERS[index],
    stranded: RIDERS[index] > 0 && DRIVERS[index] === 0,
  })),
  unspecified: { drivers: 0, riders: 0 },
  ...overrides,
});

beforeEach(() => {
  rendered = undefined;
});

describe("BarChartDaysByWeekday", () => {
  it("draws drivers and then riders, in that order, and not the other way round", () => {
    render(<BarChartDaysByWeekday daysByWeekday={daysByWeekday()} />);

    // A swapped series order here would be easy to miss if the assertion
    // named only the labels, so this names the numbers too.
    expect(rendered?.data.datasets.map((set) => set.label)).toEqual([
      "Drivers",
      "Riders",
    ]);
    expect(rendered?.data.datasets[0].data).toEqual(DRIVERS);
    expect(rendered?.data.datasets[1].data).toEqual(RIDERS);
  });

  it("has exactly seven columns, Sunday first, and no time-of-day axis", () => {
    render(<BarChartDaysByWeekday daysByWeekday={daysByWeekday()} />);

    const labels = (rendered?.data.labels ?? []).map((label) =>
      Array.isArray(label) ? label[0] : label,
    );
    expect(labels).toEqual([...WEEKDAY_NAMES]);
    expect(Object.keys(rendered?.options.scales ?? {}).sort()).toEqual([
      "x",
      "y",
    ]);
    expect(JSON.stringify(rendered?.data)).not.toMatch(/hour|time|am\b|pm\b/i);
  });

  it("says in words which day has riders and no driver, and only that day", () => {
    render(<BarChartDaysByWeekday daysByWeekday={daysByWeekday()} />);

    const labels = rendered?.data.labels as (string | string[])[];
    // Sunday: one rider and no driver. Saturday: nobody, which is not stranded.
    expect(labels[0]).toEqual(["Sunday", NO_DRIVER_DAY_SUFFIX]);
    expect(labels[1]).toBe("Monday");
    expect(labels[6]).toBe("Saturday");
  });

  it("opts out of the total-above-the-bar plugin the user-counts chart registers", () => {
    render(<BarChartDaysByWeekday daysByWeekday={daysByWeekday()} />);

    expect(
      (rendered?.options.plugins as Record<string, unknown>).totalLabelPlugin,
    ).toBe(false);
  });

  it("is sized like the other fixed-height chart, and never shrinks", () => {
    const { container } = render(
      <BarChartDaysByWeekday daysByWeekday={daysByWeekday()} />,
    );

    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveClass("h-[500px]", "shrink-0");
  });

  it("says how many people named no day, so the chart is not read as the whole population", () => {
    render(
      <BarChartDaysByWeekday
        daysByWeekday={daysByWeekday({
          unspecified: { drivers: 2, riders: 5 },
        })}
      />,
    );

    expect(
      screen.getByText(/2 drivers and 5 riders named no day/),
    ).toBeVisible();
  });

  it("adds no unspecified sentence when everyone named a day", () => {
    render(<BarChartDaysByWeekday daysByWeekday={daysByWeekday()} />);

    expect(screen.queryByText(/named no day/)).not.toBeInTheDocument();
  });

  it("draws the chart when the only people there named no day", () => {
    // Nobody on any weekday, but two people exist: the chart is empty and the
    // caption is the part that says why.
    render(
      <BarChartDaysByWeekday
        daysByWeekday={{
          days: daysByWeekday().days.map((row) => ({
            ...row,
            drivers: 0,
            riders: 0,
            stranded: false,
          })),
          unspecified: { drivers: 1, riders: 1 },
        }}
      />,
    );

    expect(screen.getByTestId("weekday-canvas")).toBeInTheDocument();
    expect(
      screen.getByText(/1 driver and 1 rider named no day and are listed/),
    ).toBeVisible();
  });

  it("says so, and draws no chart, when there is nobody to show", () => {
    render(
      <BarChartDaysByWeekday
        daysByWeekday={{
          days: daysByWeekday().days.map((row) => ({
            ...row,
            drivers: 0,
            riders: 0,
            stranded: false,
          })),
          unspecified: { drivers: 0, riders: 0 },
        }}
      />,
    );

    expect(screen.queryByTestId("weekday-canvas")).not.toBeInTheDocument();
    expect(screen.getByText(/no active drivers or riders yet/i)).toBeVisible();
    expect(rendered).toBeUndefined();
  });
});
