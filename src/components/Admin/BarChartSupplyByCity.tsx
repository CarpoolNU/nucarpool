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
import { AdminSupplyRow } from "../../utils/types";

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
);

/** What a city with riders and no driver is called on the axis. */
export const NO_DRIVER_AXIS_SUFFIX = " (no driver)";

/**
 * Room each city's pair of bars takes, and what the title, legend and value
 * axis take between them. The box is sized from the rows rather than fixed
 * because a horizontal chart with a fixed height squeezes its bars as cities
 * are added, until the labels no longer fit.
 */
const ROW_HEIGHT_PX = 56;
const CHROME_HEIGHT_PX = 150;
/** The shortest of the dashboard's chart blocks, so this one never lowers it. */
const MIN_HEIGHT_PX = 500;

interface BarChartSupplyByCityProps {
  supplyByCity: AdminSupplyRow[];
}

function BarChartSupplyByCity({ supplyByCity }: BarChartSupplyByCityProps) {
  if (supplyByCity.length === 0) {
    return (
      <p className="font-lato w-full shrink-0 text-center text-gray-500">
        No active drivers or riders yet, so there is no supply by city to show.
      </p>
    );
  }

  // The stranded flag decides the axis label. A colour would have to be one
  // of the two the series already use, and red is the drivers' - so the words
  // carry it, which is also what a screen reader is given.
  const labels = supplyByCity.map((row) =>
    row.stranded ? `${row.city}${NO_DRIVER_AXIS_SUFFIX}` : row.city,
  );

  const barData: ChartData<"bar"> = {
    labels,
    // Fixed order, drivers first, so a city's pair reads the same everywhere.
    datasets: [
      {
        label: "Drivers",
        data: supplyByCity.map((row) => row.drivers),
        backgroundColor: "#C8102E",
      },
      {
        label: "Riders",
        data: supplyByCity.map((row) => row.riders),
        backgroundColor: "#DA7D25",
      },
    ],
  };

  const barOptions: ChartOptions<"bar"> = {
    indexAxis: "y",
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
      },
      // The total-above-the-bar plugin `BarChartUserCounts` registers on every
      // chart assumes a vertical layout. Here it would draw against the wrong
      // axis, so this chart opts out the way `BarChartDaysFrequency` does.
      // @ts-ignore
      totalLabelPlugin: false,
      title: {
        display: true,
        text: "Drivers and Riders by City",
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
      y: {
        ticks: {
          font: {
            family: "Montserrat",
            size: 14,
            style: "normal",
            weight: "bold",
          },
        },
      },
    },
  };

  return (
    /*
     * Fixed height and no shrink for the reason `BarChartDaysFrequency` gives
     * at length: this is a flex item of `AdminData`'s column, which is shorter
     * than its children, and Chart.js reads its canvas size from this box's
     * computed height. The height is inline because it depends on how many
     * cities there are, and a class cannot say that.
     */
    <div
      className="flex w-full shrink-0 flex-col"
      style={{
        height: Math.max(
          MIN_HEIGHT_PX,
          supplyByCity.length * ROW_HEIGHT_PX + CHROME_HEIGHT_PX,
        ),
      }}
    >
      <Bar data={barData} options={barOptions} />
      <span className="font-lato w-full text-center text-sm text-gray-400">
        Active drivers and riders only. Viewers are not counted.
      </span>
    </div>
  );
}

export default BarChartSupplyByCity;
