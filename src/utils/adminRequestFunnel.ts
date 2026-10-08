import { RequestFunnel } from "./types";

/**
 * The admin request funnel, as an ordered list of stages a chart and a CSV can
 * both read. Pure, so the arithmetic is testable without rendering anything.
 *
 * **A stage can exceed the one before it, and this does not hide that.** A
 * request row is erased when a pair parts, and `markRequestAccepted` does not
 * retroactively flip older rows, so a rider can sit in a group with no
 * ACCEPTED request behind them. Clamping such a stage
 * would report a rate the data does not support, and a rate above 100% would
 * read as a bug. Instead the stage carries `exceedsPrevious`, its `rate` is
 * `null`, and the UI says why.
 *
 * `rate` is also `null` when the previous stage is empty: a share of nothing is
 * undefined, not `0%` and certainly not `NaN%`.
 */
export type FunnelStage = {
  key: keyof RequestFunnel;
  label: string;
  count: number;
  /** Percentage of the previous stage, one decimal place; `null` for the first stage and wherever it is undefined. */
  rate: number | null;
  /** True when this stage is larger than the one before it, so no honest rate exists. */
  exceedsPrevious: boolean;
  /** Bar length, 0-100, relative to the largest stage so it can never overflow its track. */
  widthPercent: number;
};

export const FUNNEL_STAGE_LABELS: Record<keyof RequestFunnel, string> = {
  requestsSent: "Requests sent",
  requestsAccepted: "Requests accepted",
  ridersInGroup: "Riders in a group",
};

const STAGE_ORDER: (keyof RequestFunnel)[] = [
  "requestsSent",
  "requestsAccepted",
  "ridersInGroup",
];

export function buildFunnelStages(funnel: RequestFunnel): FunnelStage[] {
  const widest = Math.max(...STAGE_ORDER.map((key) => funnel[key]));

  return STAGE_ORDER.map((key, index) => {
    const count = funnel[key];
    const previous = index === 0 ? null : funnel[STAGE_ORDER[index - 1]];
    const exceedsPrevious = previous !== null && count > previous;

    return {
      key,
      label: FUNNEL_STAGE_LABELS[key],
      count,
      rate:
        previous === null || previous === 0 || exceedsPrevious
          ? null
          : Math.round((count / previous) * 1000) / 10,
      exceedsPrevious,
      widthPercent: widest === 0 ? 0 : (count / widest) * 100,
    };
  });
}

/** The funnel has nothing to draw until at least one request exists. */
export const isFunnelEmpty = (funnel: RequestFunnel): boolean =>
  funnel.requestsSent === 0;
