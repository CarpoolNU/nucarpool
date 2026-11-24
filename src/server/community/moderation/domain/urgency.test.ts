import type { ReportReason } from "../ports";
import {
  REPORT_URGENCY,
  URGENT_REPORT_REASONS,
  isUrgentReportReason,
} from "./urgency";

describe("REPORT_URGENCY", () => {
  it("marks SAFETY_CONCERN immediate", () => {
    expect(REPORT_URGENCY.SAFETY_CONCERN).toBe("IMMEDIATE");
  });

  it("marks every other reason routine", () => {
    const routine = (Object.keys(REPORT_URGENCY) as ReportReason[]).filter(
      (reason) => REPORT_URGENCY[reason] === "ROUTINE",
    );

    expect(routine.sort()).toEqual([
      "HARASSMENT",
      "MISINFORMATION",
      "OFF_TOPIC",
      "OTHER",
      "SPAM",
    ]);
  });

  /**
   * The `Record` is the guard, and this pins what the guard is over. A reason
   * added to `ReportReason` without a bucket fails `tsc` rather than this
   * test — but a reason deleted from the map while the union keeps it would
   * also fail `tsc`, and a reason quietly added to *both* would pass both.
   * This is what notices that.
   */
  it("covers the whole reason union and nothing else", () => {
    expect(Object.keys(REPORT_URGENCY).sort()).toEqual([
      "HARASSMENT",
      "MISINFORMATION",
      "OFF_TOPIC",
      "OTHER",
      "SAFETY_CONCERN",
      "SPAM",
    ]);
  });
});

describe("isUrgentReportReason", () => {
  it("is true for SAFETY_CONCERN", () => {
    expect(isUrgentReportReason("SAFETY_CONCERN")).toBe(true);
  });

  it("is false for a routine reason", () => {
    expect(isUrgentReportReason("SPAM")).toBe(false);
  });
});

describe("URGENT_REPORT_REASONS", () => {
  /**
   * The repository's `reason IN (...)` predicate is built from this, so it is
   * the list and the predicate agreeing that keeps a filtered query honest.
   */
  it("is exactly the reasons the predicate calls urgent", () => {
    expect([...URGENT_REPORT_REASONS]).toEqual(["SAFETY_CONCERN"]);
    expect(URGENT_REPORT_REASONS.every(isUrgentReportReason)).toBe(true);
  });
});
