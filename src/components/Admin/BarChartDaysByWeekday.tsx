import React from "react";
import { Bar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ChartData,
  ChartOptions,
} from "chart.js";
import { AdminDaysByWeekday } from "../../utils/types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
);

/** Second line of a day's axis label when riders are available and no driver is. */
export const NO_DRIVER_DAY_SUFFIX = "(no driver)";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

interface BarChartDaysByWeekdayProps {
  daysByWeekday: AdminDaysByWeekday;
}

/**
 * Which weekdays active drivers and riders are each available, side by side,
 * so a day with riders and no driver stands out.
 *
 * Seven columns in `daysWorking` order and nothing else on the axis. People who
 * named no day are not a day, so they are in the caption and the table, not a
 * bar. There is no time-of-day axis: schedule times were written under four
 * historical picker conventions and are not read by this chart's query.
 */
function BarChartDaysByWeekday({ daysByWeekday }: BarChartDaysByWeekdayProps) {
  const { days, unspecified } = daysByWeekday;
  const unspecifiedTotal = unspecified.drivers + unspecified.riders;

  if (
    unspecifiedTotal === 0 &&
    days.every((row) => row.drivers === 0 && row.riders === 0)
  ) {
    return (
      <p className="font-lato w-full shrink-0 text-center text-gray-500">
        No active drivers or riders yet, so there is nothing to show by day of
        the week.
      </p>
    );
  }

  // The stranded flag decides the label. A colour would have to be one of the
  // two the series already use, so the words carry it, which is also what a
  // screen reader is given. Two lines, because seven full weekday names and a
  // suffix on one line do not fit at the width the dashboard gives a chart.
  const labels = days.map((row) =>
    row.stranded ? [row.day, NO_DRIVER_DAY_SUFFIX] : row.day,
  );

  const barData: ChartData<"bar"> = {
    labels,
    // Fixed order, drivers first, so a day's pair reads the same everywhere.
    datasets: [
      {
        label: "Drivers",
        data: days.map((row) => row.drivers),
        backgroundColor: "#C8102E",
      },
      {
        label: "Riders",
        data: days.map((row) => row.riders),
        backgroundColor: "#DA7D25",
      },
    ],
  };

  const barOptions: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
      },
      // The total-above-the-bar plugin `BarChartUserCounts` registers on every
      // chart sums stacked series. These bars are side by side, so it would
      // print a total that no bar shows; this chart opts out the way
      // `BarChartDaysFrequency` does.
      // @ts-ignore
      totalLabelPlugin: false,
      title: {
        display: true,
        text: "Drivers and Riders by Day of the Week",
        font: {
          family: "Montserrat",
          size: 18,
          style: "normal",
          weight: "bold",
        },
        color: "#000000",
      },
    },
    scales: {
      x: {
        ticks: {
          font: {
            family: "Montserrat",
            size: 14,
            style: "normal",
            weight: "bold",
          },
        },
      },
      y: {
        beginAtZero: true,
        ticks: { precision: 0 },
        title: {
          display: true,
          text: "Number of Users",
          font: {
            family: "Montserrat",
            size: 16,
            style: "normal",
            weight: "bold",
          },
        },
      },
    },
  };

  return (
    /*
     * The same fixed height and no-shrink `BarChartDaysFrequency` documents at
     * length: this is a flex item of `AdminData`'s column, which is shorter than
     * its children, and Chart.js reads its canvas size from this box's computed
     * height. Seven columns never grow with the data, so the height is a class
     * and not the inline figure `BarChartSupplyByCity` computes.
     */
    <div className="flex h-[500px] w-full shrink-0 flex-col">
      <Bar data={barData} options={barOptions} />
      <span className="font-lato w-full text-center text-sm text-gray-400">
        Active drivers and riders only. Viewers are not counted. Someone
        available on several days is counted on each.
        {unspecifiedTotal > 0
          ? ` ${count(unspecified.drivers, "driver")} and ${count(unspecified.riders, "rider")} named no day and ${unspecifiedTotal === 1 ? "is" : "are"} listed as Unspecified in the table.`
          : ""}
      </span>
    </div>
  );
}

export default BarChartDaysByWeekday;
