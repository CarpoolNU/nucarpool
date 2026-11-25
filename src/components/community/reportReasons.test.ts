import { REPORT_REASONS } from "./reportReasons";

describe("REPORT_REASONS", () => {
  it("offers every reason the procedure accepts", () => {
    expect(REPORT_REASONS.map((r) => r.value).sort()).toEqual([
      "HARASSMENT",
      "MISINFORMATION",
      "OFF_TOPIC",
      "OTHER",
      "SAFETY_CONCERN",
      "SPAM",
    ]);
  });

  it("puts OTHER last, so it is the fallback rather than the first thing offered", () => {
    expect(REPORT_REASONS.at(-1)!.value).toBe("OTHER");
  });

  it("labels each reason in words a student would use", () => {
    for (const reason of REPORT_REASONS) {
      expect(reason.label).not.toMatch(/_/);
      expect(reason.label.length).toBeGreaterThan(0);
    }
  });
});
