import {
  decideRepair,
  parseArgs,
  sortById,
  summariseRepair,
} from "./repair-wallclock-schedule-times";
import type { ScheduleTimeRow } from "../src/server/db/scheduleTimeIntegrity";

/**
 * The script overwrites two columns on production rows, so the argument parser
 * is the last thing between a typo and a write nobody intended. These pin the
 * same properties as `repair-seat-residue.test.ts`: writing is opt-in, and
 * anything unrecognised stops the run.
 *
 * Which rows are candidates, and what value the repair writes, are covered in
 * `src/server/db/scheduleTimeIntegrity.test.ts` — that is where that half
 * lives. What is tested here is what this script owns: the count the dry run
 * has to state, a stable report order, and the re-check that decides whether a
 * planned write still happens. Importing this module is safe because it only
 * calls `main()` when run directly.
 */

const stored = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const row = (
  id: string,
  overrides: Partial<ScheduleTimeRow> = {},
): ScheduleTimeRow => ({
  id,
  userId: `user-${id}`,
  role: "RIDER",
  status: "ACTIVE",
  startTime: stored("09:00"),
  endTime: stored("17:00"),
  startDate: day("2026-07-10"),
  endDate: day("2026-12-10"),
  ...overrides,
});

const candidate = (id: string, overrides: Partial<ScheduleTimeRow> = {}) => ({
  row: row(id, overrides),
  repairStartTime: stored("14:00"),
  repairEndTime: stored("22:00"),
});

describe("repair-wallclock-schedule-times argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 50 });
  });

  it("only writes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // The more cautious of two conflicting flags wins.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("accepts a raised --max", () => {
    expect(parseArgs(["--max", "200"])).toEqual({ apply: false, max: 200 });
  });

  it("rejects a --max that is not a positive integer", () => {
    expect(() => parseArgs(["--max", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "-3"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "2.5"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--max", "lots"])).toThrow(/positive integer/);
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
  });
});

describe("summariseRepair", () => {
  it("counts the rows a run would write", () => {
    expect(summariseRepair([candidate("a"), candidate("b")])).toEqual({
      rowCount: 2,
    });
  });

  it("reports nothing to do for an empty plan", () => {
    expect(summariseRepair([])).toEqual({ rowCount: 0 });
  });
});

describe("sortById", () => {
  it("orders candidates so two runs print the same lines in the same order", () => {
    const sorted = sortById([candidate("c"), candidate("a"), candidate("b")]);

    expect(sorted.map((entry) => entry.row.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its argument", () => {
    const plan = [candidate("b"), candidate("a")];
    sortById(plan);

    expect(plan.map((entry) => entry.row.id)).toEqual(["b", "a"]);
  });
});

describe("decideRepair", () => {
  const asOf = day("2026-09-21");

  it("writes when the row is unchanged since the plan was built", () => {
    expect(decideRepair(row("a"), asOf)).toEqual({ action: "repair" });
  });

  it("skips a row that has since been deleted", () => {
    expect(decideRepair(null, asOf)).toEqual({
      action: "skip",
      reason: "the row no longer exists",
    });
  });

  it("skips a row whose schedule was re-entered in the meantime", () => {
    // The user retyped their time between the plan and the write, so it is
    // already canonical. Adding five hours to it would be the real damage
    // this re-check exists to prevent.
    const decision = decideRepair(
      row("a", { startTime: stored("14:00"), endTime: stored("22:00") }),
      asOf,
    );

    expect(decision).toEqual({
      action: "skip",
      reason: "the schedule is no longer a wall-clock value",
    });
  });

  it("skips a row whose co-op dates were changed out of range", () => {
    const decision = decideRepair(
      row("a", { startDate: day("2027-01-04"), endDate: day("2027-06-04") }),
      asOf,
    );

    expect(decision).toEqual({
      action: "skip",
      reason: "the co-op is no longer running",
    });
  });

  it("skips a row whose schedule was cleared", () => {
    const decision = decideRepair(
      row("a", { startTime: null, endTime: null }),
      asOf,
    );

    expect(decision).toEqual({
      action: "skip",
      reason: "the schedule is no longer a wall-clock value",
    });
  });
});
