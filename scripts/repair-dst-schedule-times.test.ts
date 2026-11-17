/**
 * The planning half of the DST schedule repair.
 *
 * Importing the script runs its module body, which is why `main()` sits behind
 * a `require.main` check: nothing here opens a database or writes anything.
 *
 * The properties worth pinning are the ones that stand between a dry run and a
 * destructive one — that writing needs `--apply`, that no near-miss spelling
 * reaches a write, and that the pre-write re-check refuses every row whose
 * state has moved since the plan was built.
 */

import {
  decideRepair,
  parseArgs,
  sortById,
  summariseRepair,
} from "./repair-dst-schedule-times";
import type { ScheduleTimeAuditRow } from "../src/server/db/dstScheduleIntegrity";
import type { DstScheduleRow } from "../src/server/db/dstScheduleIntegrity";

const storedAt = (hour: number, minute = 0) =>
  new Date(Date.UTC(1970, 0, 1, hour, minute, 0));

const EDT_2026_JULY = new Date("2026-07-15T12:00:00.000Z");
const ON_COOP = new Date("2026-11-16T12:00:00.000Z");

const auditRow = (
  overrides: Partial<ScheduleTimeAuditRow> = {},
): ScheduleTimeAuditRow => ({
  id: "cs_1",
  userId: "u_1",
  role: "DRIVER",
  status: "ACTIVE",
  startTime: storedAt(13),
  endTime: storedAt(21),
  startDate: new Date("2026-09-01T00:00:00.000Z"),
  endDate: new Date("2026-12-31T00:00:00.000Z"),
  dateCreated: EDT_2026_JULY,
  dateModified: EDT_2026_JULY,
  ...overrides,
});

const candidate = (id: string): DstScheduleRow => ({
  row: auditRow({ id }),
  repairStartTime: storedAt(14),
  repairEndTime: storedAt(22),
});

describe("parseArgs", () => {
  it("reports rather than writes by default", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 300 });
  });

  it("writes only for exactly --apply", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
  });

  it.each(["--Apply", "-apply", "apply", "--apply=true", "--force"])(
    "throws on %s rather than ignoring it",
    (arg) => {
      expect(() => parseArgs([arg])).toThrow(/unknown argument/);
    },
  );

  it("lets the last of --apply and --dry-run win", () => {
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
    expect(parseArgs(["--dry-run", "--apply"]).apply).toBe(true);
  });

  it("requires --max to be a positive integer", () => {
    expect(parseArgs(["--max", "12"]).max).toBe(12);
    expect(() => parseArgs(["--max"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "-5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "1.5"])).toThrow(/positive integer/);
  });
});

describe("summariseRepair", () => {
  it("counts the rows that would be overwritten", () => {
    expect(summariseRepair([])).toEqual({ rowCount: 0 });
    expect(summariseRepair([candidate("a"), candidate("b")])).toEqual({
      rowCount: 2,
    });
  });
});

describe("sortById", () => {
  it("orders candidates so two runs print the same plan", () => {
    const sorted = sortById([candidate("c"), candidate("a"), candidate("b")]);

    expect(sorted.map((entry) => entry.row.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [candidate("c"), candidate("a")];
    sortById(input);

    expect(input.map((entry) => entry.row.id)).toEqual(["c", "a"]);
  });
});

describe("decideRepair", () => {
  it("repairs a row that still matches the plan", () => {
    expect(decideRepair(auditRow(), ON_COOP)).toEqual({ action: "repair" });
  });

  it("skips a row that has gone", () => {
    expect(decideRepair(null, ON_COOP)).toEqual({
      action: "skip",
      reason: "the row no longer exists",
    });
  });

  it("skips a schedule cleared since the plan was built", () => {
    expect(
      decideRepair(auditRow({ startTime: null, endTime: null }), ON_COOP),
    ).toEqual({
      action: "skip",
      reason: "the schedule has since been cleared",
    });
  });

  it("skips a row saved since the plan was built, which is the case that matters", () => {
    // Someone opened their profile and retyped their schedule. `dateModified`
    // is now past the fix cutoff, so the value they entered is correct and
    // writing the planned one over it would introduce the very defect this
    // repair undoes.
    const retyped = auditRow({
      startTime: storedAt(14),
      endTime: storedAt(22),
      dateModified: new Date("2026-11-16T09:00:00.000Z"),
    });

    expect(decideRepair(retyped, ON_COOP)).toEqual({
      action: "skip",
      reason: "the row has been saved since the plan was built",
    });
  });

  it("skips a co-op that has ended since the plan was built", () => {
    const ended = auditRow({
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(decideRepair(ended, ON_COOP)).toEqual({
      action: "skip",
      reason: "the co-op is no longer running",
    });
  });

  it("skips a wall-clock value, which a different repair owns", () => {
    const wallClock = auditRow({
      startTime: storedAt(9),
      endTime: storedAt(17),
    });

    expect(decideRepair(wallClock, ON_COOP)).toEqual({
      action: "skip",
      reason: "the schedule now reads as a wall-clock value",
    });
  });
});
