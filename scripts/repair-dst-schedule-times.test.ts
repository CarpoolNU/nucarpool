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

import { mkdtempSync, statSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildManifest,
  decideRepair,
  defaultManifestPath,
  extractManifestPath,
  parseArgs,
  recordOutcome,
  repairStatement,
  sortById,
  summariseRepair,
  toSqlDateTime,
  toSqlTime,
  writeManifest,
} from "./repair-dst-schedule-times";
import { isProvablyDstWritten } from "../src/server/db/dstScheduleIntegrity";
import type { ScheduleTimeAuditRow } from "../src/server/db/dstScheduleIntegrity";
import type { DstScheduleRow } from "../src/server/db/dstScheduleIntegrity";

const storedAt = (hour: number, minute = 0) =>
  new Date(Date.UTC(1970, 0, 1, hour, minute, 0));

const EDT_2026_JULY = new Date("2026-07-15T12:00:00.000Z");
const ON_COOP = new Date("2026-11-16T12:00:00.000Z");
const BOSTON = { coordLat: 42.34, coordLng: -71.09 };

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
  companyCoords: BOSTON,
  homeCoords: BOSTON,
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

describe("toSqlTime", () => {
  it("reads the stored digits in UTC, not the runner's zone", () => {
    // CI runs this suite under both UTC and America/New_York. A local
    // accessor here would send different digits to MySQL on the two runs.
    expect(toSqlTime(storedAt(14))).toBe("14:00:00");
    expect(toSqlTime(storedAt(0, 30))).toBe("00:30:00");
    expect(toSqlTime(storedAt(23, 45))).toBe("23:45:00");
  });
});

describe("toSqlDateTime", () => {
  it("keeps millisecond precision, which the compare-and-swap depends on", () => {
    expect(toSqlDateTime(new Date("2026-07-15T12:34:56.789Z"))).toBe(
      "2026-07-15 12:34:56.789",
    );
  });

  it("pads every field, including a sub-100ms millisecond", () => {
    expect(toSqlDateTime(new Date("2026-01-02T03:04:05.006Z"))).toBe(
      "2026-01-02 03:04:05.006",
    );
  });
});

describe("repairStatement", () => {
  const stmt = () =>
    repairStatement(
      "cs_1",
      storedAt(14),
      storedAt(22),
      new Date("2026-07-15T12:34:56.789Z"),
    );

  // Structural, because no behavioural test can see these. A statement that
  // dropped the date_modified assignment would still repair the row; it would
  // just silently stop being safe to re-run. One that dropped the WHERE term
  // would still repair the row; it would just silently stop being a
  // compare-and-swap.
  it("assigns date_modified, because raw SQL bypasses @updatedAt", () => {
    expect(stmt().sql).toMatch(/date_modified\s*=\s*NOW\(3\)/);
  });

  it("puts date_modified in the WHERE, which is what makes it a swap", () => {
    const where = stmt().sql.split(/WHERE/i)[1];

    expect(where).toBeDefined();
    expect(where).toMatch(/date_modified\s*=\s*\?/);
    expect(where).toMatch(/id\s*=\s*\?/);
  });

  it("binds the values as parameters rather than interpolating them", () => {
    expect(stmt().values).toEqual([
      "14:00:00",
      "22:00:00",
      "cs_1",
      "2026-07-15 12:34:56.789",
    ]);
  });

  it("writes both columns in the one statement", () => {
    expect(stmt().sql).toMatch(/start_time\s*=/);
    expect(stmt().sql).toMatch(/end_time\s*=/);
  });
});

describe("rerun safety", () => {
  it("cannot select a row again once the repair has stamped date_modified", () => {
    // The property the whole script leans on. A repaired row keeps timestamps
    // that the span rule would otherwise still accept - 13:00 becomes 14:00,
    // and July is still July - so what excludes it is date_modified having
    // moved past the fix cutoff.
    const beforeRepair = auditRow();
    expect(isProvablyDstWritten(beforeRepair)).toBe(true);

    const afterRepair = auditRow({ dateModified: new Date() });
    expect(isProvablyDstWritten(afterRepair)).toBe(false);
  });

  it("stays excluded even when the repair runs during daylight saving", () => {
    // A run in July leaves date_modified inside a DST window, so the season
    // half of the rule still passes. The fix cutoff is what refuses it.
    const repairedInSummer = auditRow({
      dateModified: new Date("2027-07-04T12:00:00.000Z"),
    });

    expect(isProvablyDstWritten(repairedInSummer)).toBe(false);
  });
});

describe("extractManifestPath", () => {
  it("pulls the path out and leaves the rest for the shared parser", () => {
    expect(extractManifestPath(["--apply", "--manifest", "run.json"])).toEqual({
      manifestPath: "run.json",
      rest: ["--apply"],
    });
  });

  it("returns no path when the flag is absent", () => {
    expect(extractManifestPath(["--apply"])).toEqual({
      manifestPath: null,
      rest: ["--apply"],
    });
  });

  it("throws rather than swallowing the next flag as a path", () => {
    expect(() => extractManifestPath(["--manifest", "--apply"])).toThrow(
      /--manifest expects a path/,
    );
    expect(() => extractManifestPath(["--manifest"])).toThrow(
      /--manifest expects a path/,
    );
  });

  it("leaves an unknown argument for the shared parser to reject", () => {
    const { rest } = extractManifestPath(["--force"]);

    expect(() => parseArgs(rest)).toThrow(/unknown argument/);
  });
});

describe("defaultManifestPath", () => {
  it("is timestamped, so two runs never collide", () => {
    const path = defaultManifestPath(new Date("2026-11-17T15:04:05.123Z"));

    expect(path).toBe("dst-schedule-repair-2026-11-17T15-04-05-123Z.json");
    expect(path).not.toContain(":");
  });
});

describe("buildManifest", () => {
  const meta = {
    asOf: ON_COOP,
    mode: "apply" as const,
    now: new Date("2026-11-17T15:00:00.000Z"),
  };

  it("records the prior and proposed value of every row", () => {
    const manifest = buildManifest([candidate("cs_1")], meta);

    expect(manifest.rows).toHaveLength(1);
    expect(manifest.rows[0]).toMatchObject({
      searchId: "cs_1",
      userId: "u_1",
      priorStartTime: "13:00:00",
      priorEndTime: "21:00:00",
      proposedStartTime: "14:00:00",
      proposedEndTime: "22:00:00",
      outcome: "pending",
    });
  });

  it("records the date_modified the compare-and-swap is keyed on", () => {
    const manifest = buildManifest([candidate("cs_1")], meta);

    expect(manifest.rows[0].dateModifiedAtPlan).toBe(
      EDT_2026_JULY.toISOString(),
    );
    expect(manifest.rows[0].dateCreated).toBe(EDT_2026_JULY.toISOString());
  });

  it("marks a dry run as such, so a plan is never mistaken for a record of writes", () => {
    const manifest = buildManifest([candidate("cs_1")], {
      ...meta,
      mode: "dry-run",
    });

    expect(manifest.mode).toBe("dry-run");
    expect(manifest.rows[0].outcome).toBe("dry-run");
  });

  it("carries rollback instructions that do not restore date_modified", () => {
    const manifest = buildManifest([candidate("cs_1")], meta);

    expect(manifest.rollback).toMatch(/UPDATE carpool_search/);
    expect(manifest.rollback).toMatch(/Do NOT restore date_modified/);
  });

  it("describes every candidate before any of them is written", () => {
    const manifest = buildManifest(
      [candidate("cs_1"), candidate("cs_2"), candidate("cs_3")],
      meta,
    );

    expect(manifest.candidateCount).toBe(3);
    expect(manifest.rows.map((row) => row.outcome)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });
});

describe("recordOutcome", () => {
  const manifest = () =>
    buildManifest([candidate("cs_1"), candidate("cs_2")], {
      asOf: ON_COOP,
      mode: "apply",
      now: new Date("2026-11-17T15:00:00.000Z"),
    });

  it("resolves one row and leaves the others pending", () => {
    const m = manifest();

    expect(recordOutcome(m, "cs_1", "repaired")).toBe(true);
    expect(m.rows[0].outcome).toBe("repaired");
    expect(m.rows[1].outcome).toBe("pending");
  });

  it("keeps the reason a row was skipped", () => {
    const m = manifest();
    recordOutcome(m, "cs_2", "skipped", "the co-op is no longer running");

    expect(m.rows[1]).toMatchObject({
      outcome: "skipped",
      note: "the co-op is no longer running",
    });
  });

  it("leaves a partial run's untouched rows at pending", () => {
    // What a crash after the first row looks like on disk: row one resolved,
    // row two still pending and still carrying its prior values.
    const m = manifest();
    recordOutcome(m, "cs_1", "failed", "connection lost");

    expect(m.rows.map((row) => row.outcome)).toEqual(["failed", "pending"]);
    expect(m.rows[1].priorStartTime).toBe("13:00:00");
  });

  it("reports an id it does not hold rather than inventing a row", () => {
    expect(recordOutcome(manifest(), "cs_missing", "repaired")).toBe(false);
  });
});

describe("writeManifest", () => {
  const manifest = () =>
    buildManifest([candidate("cs_1")], {
      asOf: ON_COOP,
      mode: "apply",
      now: new Date("2026-11-17T15:00:00.000Z"),
    });

  it("writes the record at mode 0600, since it holds a user id per row", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dst-manifest-")), "run.json");

    writeManifest(path, manifest());

    // Low nine bits only: the file type bits are not what this is about.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).rows[0].searchId).toBe(
      "cs_1",
    );
  });

  it("refuses an existing path rather than destroying a previous rollback record", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dst-manifest-")), "run.json");
    writeFileSync(path, "{}");

    expect(() => writeManifest(path, manifest())).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{}");
  });
});
