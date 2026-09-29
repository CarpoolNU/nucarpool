import { buildFunnelStages, isFunnelEmpty } from "./adminRequestFunnel";

/**
 * The arithmetic behind the admin request funnel. Pure, so every case that
 * matters - an empty platform, a stage larger than the one before it - can be
 * stated as numbers in and numbers out, without rendering a chart.
 */

const stagesOf = (
  requestsSent: number,
  requestsAccepted: number,
  ridersInGroup: number,
) => buildFunnelStages({ requestsSent, requestsAccepted, ridersInGroup });

describe("buildFunnelStages", () => {
  it("orders the stages sent, accepted, in a group, and rates each against the one before", () => {
    const stages = stagesOf(200, 50, 25);

    expect(stages.map((stage) => stage.key)).toEqual([
      "requestsSent",
      "requestsAccepted",
      "ridersInGroup",
    ]);
    expect(stages.map((stage) => stage.count)).toEqual([200, 50, 25]);
    // The first stage has nothing before it to be a share of.
    expect(stages.map((stage) => stage.rate)).toEqual([null, 25, 50]);
  });

  it("rounds a rate to one decimal place", () => {
    expect(stagesOf(3, 1, 1)[1].rate).toBe(33.3);
  });

  it("sizes each bar against the largest stage, so the first is full width", () => {
    expect(stagesOf(200, 50, 25).map((stage) => stage.widthPercent)).toEqual([
      100, 25, 12.5,
    ]);
  });

  describe("with no requests at all", () => {
    const stages = stagesOf(0, 0, 0);

    it("gives no stage a rate, rather than dividing zero by zero", () => {
      for (const stage of stages) {
        expect(stage.rate).toBeNull();
        expect(Number.isNaN(stage.widthPercent)).toBe(false);
        expect(stage.widthPercent).toBe(0);
      }
    });

    it("flags nothing as exceeding the stage before it", () => {
      expect(stages.some((stage) => stage.exceedsPrevious)).toBe(false);
    });
  });

  describe("when a stage is larger than the one before it", () => {
    // A rider is in a group but the pair's request row was erased, so the
    // funnel has 1 sent, 0 accepted and 1 rider grouped.
    const stages = stagesOf(1, 0, 1);

    it("reports no rate for it, since one above 100% would read as a bug", () => {
      expect(stages[2].exceedsPrevious).toBe(true);
      expect(stages[2].rate).toBeNull();
    });

    it("does not clamp the count, which is the real figure", () => {
      expect(stages[2].count).toBe(1);
    });

    it("keeps every bar inside its track", () => {
      for (const stage of stages) {
        expect(stage.widthPercent).toBeLessThanOrEqual(100);
      }
    });

    it("still reports 0% for an empty stage that follows a non-empty one", () => {
      expect(stages[1].count).toBe(0);
      expect(stages[1].rate).toBe(0);
      expect(stages[1].exceedsPrevious).toBe(false);
    });
  });

  it("gives no rate to a stage whose predecessor is empty, without flagging it as exceeding", () => {
    // Nothing sent and nothing accepted, but a rider is grouped: 1 > 0, so it
    // is flagged; a stage of 0 after 0 is not.
    const [, accepted, grouped] = stagesOf(0, 0, 1);

    expect(accepted.rate).toBeNull();
    expect(accepted.exceedsPrevious).toBe(false);
    expect(grouped.exceedsPrevious).toBe(true);
    expect(grouped.rate).toBeNull();
  });

  it("marks a healthy funnel as exceeding nowhere", () => {
    expect(stagesOf(10, 4, 3).every((stage) => !stage.exceedsPrevious)).toBe(
      true,
    );
  });
});

describe("isFunnelEmpty", () => {
  it("is empty exactly when no request was sent", () => {
    expect(
      isFunnelEmpty({ requestsSent: 0, requestsAccepted: 0, ridersInGroup: 0 }),
    ).toBe(true);
    expect(
      isFunnelEmpty({ requestsSent: 1, requestsAccepted: 0, ridersInGroup: 0 }),
    ).toBe(false);
  });
});
