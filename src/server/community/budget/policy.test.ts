import type { CommunityBudgetAction } from "@prisma/client";
import { BUDGET_RULES, DAY_MS, HOUR_MS, budgetWindowStart } from "./policy";

describe("budgetWindowStart", () => {
  it("floors to the start of the hour bucket", () => {
    expect(
      budgetWindowStart(new Date("2026-02-01T13:47:12.345Z"), HOUR_MS),
    ).toEqual(new Date("2026-02-01T13:00:00.000Z"));
  });

  it("returns a boundary instant unchanged", () => {
    const boundary = new Date("2026-02-01T13:00:00.000Z");
    expect(budgetWindowStart(boundary, HOUR_MS)).toEqual(boundary);
  });

  it("floors a 24h window to midnight UTC, not a rolling day", () => {
    expect(
      budgetWindowStart(new Date("2026-02-01T23:59:59.999Z"), DAY_MS),
    ).toEqual(new Date("2026-02-01T00:00:00.000Z"));
  });

  it("puts two instants in the same hour in the same bucket", () => {
    const a = budgetWindowStart(new Date("2026-02-01T13:00:00.000Z"), HOUR_MS);
    const b = budgetWindowStart(new Date("2026-02-01T13:59:59.999Z"), HOUR_MS);
    expect(a).toEqual(b);
  });
});

describe("BUDGET_RULES", () => {
  it("carries every action in the enum", () => {
    const actions: CommunityBudgetAction[] = [
      "HANDLE_CLAIM",
      "POST_CREATE",
      "COMMENT_CREATE",
      "VOTE",
      "SAVE",
      "REPORT_CREATE",
    ];
    for (const action of actions) {
      expect(BUDGET_RULES[action].limit).toBeGreaterThan(0);
      expect(BUDGET_RULES[action].windowMs).toBeGreaterThan(0);
    }
  });

  it("matches the limits the spec fixes", () => {
    expect(BUDGET_RULES.HANDLE_CLAIM).toEqual({ limit: 5, windowMs: DAY_MS });
    expect(BUDGET_RULES.POST_CREATE).toEqual({ limit: 10, windowMs: HOUR_MS });
    expect(BUDGET_RULES.COMMENT_CREATE).toEqual({
      limit: 60,
      windowMs: HOUR_MS,
    });
    expect(BUDGET_RULES.VOTE).toEqual({ limit: 200, windowMs: HOUR_MS });
    expect(BUDGET_RULES.SAVE).toEqual({ limit: 200, windowMs: HOUR_MS });
    expect(BUDGET_RULES.REPORT_CREATE).toEqual({ limit: 20, windowMs: DAY_MS });
  });
});
