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

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
);

interface BarChartOnboardingProps {
  riderDayCount: number[];
  driverDayCount: number[];
}

function BarChartDaysFrequency({
  riderDayCount,
  driverDayCount,
}: BarChartOnboardingProps) {
  const labels = ["Su", "M", "Tu", "W", "Th", "F", "S"];

  const barData: ChartData<"bar"> = {
    labels,

    datasets: [
      {
        label: "Riders",
        data: riderDayCount,
        backgroundColor: "#DA7D25",
      },
      {
        label: "Drivers",
        data: driverDayCount,
        backgroundColor: "#C8102E",
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
      // @ts-ignore
      totalLabelPlugin: false,
      title: {
        display: true,
        text: "Days Carpooling Frequency",
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
        stacked: true,
        ticks: {
          font: {
            family: "Montserrat",
            size: 16,
            style: "normal",
            weight: "bold",
          },
        },
      },
      y: {
        stacked: true,
        beginAtZero: true,
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
     * The no-shrink is load-bearing and the height alone is not.
     *
     * This is a flex item of `AdminData`'s column, and that column's children
     * sum to more than the content row at every viewport. `flex-shrink`
     * defaults to 1 and `min-height: auto` does not stop it, so before
     * SCRUM-488 the box was shrunk to whatever was left - measured in Chromium
     * at 151.5px at 1440x900 and 24px at 667x582, against a class string that
     * says 500. It is silent, which is what made it survive: nothing about the
     * markup reads as wrong. The other two chart blocks escape it by declaring
     * a `min-h-` floor instead, because a minimum is a floor a shrink cannot
     * cross.
     *
     * A fixed height plus no shrink rather than that same floor, and the
     * difference is about the canvas rather than about house style.
     * `maintainAspectRatio` is false, so Chart.js takes the canvas's size from
     * this element's computed height; keeping the height definite keeps that
     * measurement exactly what the class says, where a floor alone would leave
     * it `auto` and let the caption below decide it. The layout fixture cannot
     * tell the two apart - its stand-in for the canvas is a `flex-1` box, so
     * both measure 500 there - which is why the reason is written down rather
     * than measured.
     *
     * `ADMIN_SHORTEST_CHART_HEIGHT_PX` derives the console's height gate from
     * this 500, so the box rendering at exactly 500 is what makes that constant
     * a description rather than an aspiration.
     */
    <div className="flex h-[500px] w-full shrink-0 flex-col">
      <Bar data={barData} options={barOptions} />
      <span className="font-lato w-full text-center text-sm text-gray-400">
        All bars currently only include active users aside from
        &quot;Inactive&quot;
      </span>
    </div>
  );
}

export default BarChartDaysFrequency;
