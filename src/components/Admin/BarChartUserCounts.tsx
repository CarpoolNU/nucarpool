import React from "react";
import { Bar } from "react-chartjs-2";
import { AdminUserCounts } from "../../utils/types";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  ChartTypeRegistry,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ChartData,
  ChartOptions,
} from "chart.js";
const totalLabelPlugin = {
  id: "totalLabelPlugin",
  afterDatasetsDraw: (chart: ChartJS<keyof ChartTypeRegistry, any, any>) => {
    const {
      ctx,
      scales: { x, y },
    } = chart;
    const datasets = chart.data.datasets;

    chart.data.labels?.forEach((label, index) => {
      const total = datasets.reduce((sum, dataset, datasetIndex) => {
        if (!chart.isDatasetVisible(datasetIndex)) {
          return sum;
        }
        const value = (dataset.data[index] as number) || 0;
        return sum + value;
      }, 0);

      if (total > 0) {
        const xPos = x.getPixelForValue(label);
        const yPos = y.getPixelForValue(total) - 10;

        ctx.save();
        ctx.font = "bold 12px Montserrat";
        ctx.textAlign = "center";
        ctx.fillStyle = "black";
        ctx.fillText(total.toString(), xPos, yPos);
        ctx.restore();
      }
    });
  },
};
ChartJS.register(
  CategoryScale,
  totalLabelPlugin,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
);

/**
 * The props are exactly `AdminUserCounts`, which is what `admin.getStats`
 * returns and what `AdminData` spreads in. Aliasing rather than restating the
 * sixteen fields keeps the chart from drifting out of step with the server:
 * a count added to `AdminUserCounts` arrives here as a type error instead of
 * compiling against a stale local copy.
 */
type BarChartOnboardingProps = AdminUserCounts;

function BarChartUserCounts({
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
}: BarChartOnboardingProps) {
  const labels = ["Total", "Driver", "Rider", "Viewer"];

  const barData: ChartData<"bar"> = {
    labels,
    datasets: [
      {
        label: "Active Onboarded",
        data: [totalAO, driverAO, riderAO, viewerAO],
        backgroundColor: "#C8102E",
      },
      {
        label: "Active Not Onboarded",
        data: [totalANO, driverANO, riderANO, viewerANO],
        backgroundColor: "#FFA9A9",
      },
      {
        label: "Inactive Onboarded",
        data: [totalIO, driverIO, riderIO, viewerIO],
        backgroundColor: "#808080",
      },
      {
        label: "Inactive Not Onboarded",
        data: [totalINO, driverINO, riderINO, viewerINO],
        backgroundColor: "#000000",
      },
    ],
  };

  const barOptions: ChartOptions<"bar"> = {
    responsive: true,
    maintainAspectRatio: false,

    plugins: {
      legend: {
        display: true,
        position: "top",
        labels: {
          font: {
            family: "Montserrat",
            size: 14,
            style: "normal",
            weight: "bold",
          },
        },
      },
      title: {
        display: true,
        text: "User Counts by Status and Onboarding",
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
        grid: {
          display: false,
        },
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
        grid: {
          display: false,
        },
        ticks: {
          stepSize: 100,
        },
        stacked: true,
        beginAtZero: true,
        grace: 50,
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
    <div className="relative min-h-[600px] w-full">
      <Bar data={barData} options={barOptions} />
    </div>
  );
}

export default BarChartUserCounts;
