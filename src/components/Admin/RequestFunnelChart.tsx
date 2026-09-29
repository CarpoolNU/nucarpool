import React from "react";
import {
  buildFunnelStages,
  isFunnelEmpty,
} from "../../utils/adminRequestFunnel";
import { RequestFunnel } from "../../utils/types";

interface RequestFunnelChartProps {
  funnel: RequestFunnel;
}

/**
 * Where requests stop: sent, accepted, and a rider in a group.
 *
 * Drawn from markup rather than Chart.js. A funnel is three lengths, the
 * numbers are the point, and a real `<table>` is then the accessible reading
 * of the chart instead of a second thing to keep in step with a canvas.
 *
 * **The caption is not optional.** These are counts of the platform as it is
 * now: a request and its group are erased when a pair parts, so an unlabelled
 * bar reads as a lifetime conversion rate, which it is not. It sits under the
 * chart the way the sibling charts carry theirs, and it renders in the empty
 * state too.
 *
 * `shrink-0` for the reason `BarChartDaysFrequency` documents: this is a flex
 * item of `AdminData`'s column, and without it the column squeezes the block.
 * It has no fixed height because it holds no canvas to measure, so it is never
 * the shortest chart `ADMIN_SHORTEST_CHART_HEIGHT_PX` describes.
 */
function RequestFunnelChart({ funnel }: RequestFunnelChartProps) {
  const stages = buildFunnelStages(funnel);
  const anyExceeds = stages.some((stage) => stage.exceedsPrevious);

  return (
    <section
      aria-labelledby="request-funnel-title"
      className="font-lato flex w-full shrink-0 flex-col space-y-3"
    >
      <h2
        id="request-funnel-title"
        className="font-montserrat text-center text-lg font-bold text-black"
      >
        Request Funnel
      </h2>

      {isFunnelEmpty(funnel) ? (
        <p className="py-6 text-center text-gray-600">
          No requests have been sent yet, so there is no funnel to show.
        </p>
      ) : (
        <>
          <div aria-hidden="true" className="flex flex-col space-y-2">
            {stages.map((stage) => (
              <div key={stage.key} className="flex items-center space-x-3">
                <span className="w-44 shrink-0 text-right text-sm">
                  {stage.label}
                </span>
                <div className="h-8 flex-1 rounded bg-gray-100">
                  <div
                    className="bg-northeastern-red h-full rounded"
                    style={{ width: `${stage.widthPercent}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <table className="mx-auto text-sm">
            <caption className="sr-only">
              Requests sent, requests accepted, and riders in a group, with each
              stage as a share of the one before it.
            </caption>
            <thead>
              <tr className="text-left">
                <th scope="col" className="pr-8 font-bold">
                  Stage
                </th>
                <th scope="col" className="pr-8 text-right font-bold">
                  Count
                </th>
                <th scope="col" className="text-right font-bold">
                  Of previous stage
                </th>
              </tr>
            </thead>
            <tbody>
              {stages.map((stage) => (
                <tr key={stage.key}>
                  <th scope="row" className="pr-8 text-left font-normal">
                    {stage.label}
                  </th>
                  <td className="pr-8 text-right tabular-nums">
                    {stage.count}
                  </td>
                  <td className="text-right tabular-nums">
                    {stage.rate === null
                      ? stage.exceedsPrevious
                        ? "n/a *"
                        : "-"
                      : `${stage.rate}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {anyExceeds && (
            <p className="text-center text-sm text-gray-600">
              * This stage is larger than the one before it, so it has no rate.
              A rider can be in a group with no accepted request behind them:
              the pair&apos;s request was erased, or the group predates
              acceptances being recorded.
            </p>
          )}
        </>
      )}

      <p className="text-center text-sm text-gray-600">
        Current state, not lifetime. A request and its group are erased when a
        pair parts, so these counts describe today&apos;s pairings, not every
        request ever sent. Drivers are not counted in the last stage: a driver
        has no request of their own to be accepted.
      </p>
    </section>
  );
}

export default RequestFunnelChart;
