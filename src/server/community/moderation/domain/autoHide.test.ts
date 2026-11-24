import { COMMUNITY_AUTOHIDE_REPORTERS, shouldAutoHide } from "./autoHide";

describe("shouldAutoHide", () => {
  it("is false below the threshold", () => {
    expect(
      shouldAutoHide({
        distinctOpenReporters: COMMUNITY_AUTOHIDE_REPORTERS - 1,
        hasDismissedReport: false,
      }),
    ).toBe(false);
  });

  it("is true at the threshold", () => {
    expect(
      shouldAutoHide({
        distinctOpenReporters: COMMUNITY_AUTOHIDE_REPORTERS,
        hasDismissedReport: false,
      }),
    ).toBe(true);
  });

  it("is true above the threshold", () => {
    expect(
      shouldAutoHide({
        distinctOpenReporters: COMMUNITY_AUTOHIDE_REPORTERS + 4,
        hasDismissedReport: false,
      }),
    ).toBe(true);
  });

  it("stays false once a moderator has dismissed a report on this target", () => {
    expect(
      shouldAutoHide({ distinctOpenReporters: 9, hasDismissedReport: true }),
    ).toBe(false);
  });
});
