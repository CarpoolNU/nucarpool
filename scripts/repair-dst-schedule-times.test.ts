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

import fs, {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Prisma } from "@prisma/client";
import {
  CANARY_MAX,
  NEVER_EDITED_TOLERANCE_MS,
  applyRepairs,
  buildManifest,
  decideApprovedCore,
  decideRepair,
  defaultManifestPath,
  extractManifestPath,
  extractOnlyIds,
  isApprovedCoreRow,
  maxRefusalMessage,
  parseArgs,
  recordOutcome,
  replaceManifest,
  repairStatement,
  selectOnly,
  sortById,
  summariseRepair,
  toSqlDateTime,
  toSqlTime,
  writeManifest,
  type Manifest,
  type RepairStore,
} from "./repair-dst-schedule-times";
import {
  SCHEDULE_FIX_DEPLOYED_AT,
  findDstWrittenScheduleRows,
  isProvablyDstWritten,
} from "../src/server/db/dstScheduleIntegrity";
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

/** The row as the plan read it, for the re-checks that compare against it. */
const PLANNED = auditRow();

/** A `date_modified` stamp past the fix cutoff, as a run would choose. */
const STAMP = new Date("2026-11-17T15:00:00.123Z");

/** Manifest metadata for an `--apply` run. */
const META = { asOf: ON_COOP, mode: "apply" as const, now: STAMP };

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
    expect(decideRepair(auditRow(), PLANNED, ON_COOP)).toEqual({
      action: "repair",
    });
  });

  it("skips a row that has gone", () => {
    expect(decideRepair(null, PLANNED, ON_COOP)).toEqual({
      action: "skip",
      reason: "the row no longer exists",
    });
  });

  it("skips a schedule cleared since the plan was built", () => {
    expect(
      decideRepair(
        auditRow({ startTime: null, endTime: null }),
        PLANNED,
        ON_COOP,
      ),
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

    expect(decideRepair(retyped, PLANNED, ON_COOP)).toEqual({
      action: "skip",
      reason: "the row has been saved since the plan was built",
    });
  });

  it("skips a co-op that has ended since the plan was built", () => {
    const ended = auditRow({
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      endDate: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(decideRepair(ended, PLANNED, ON_COOP)).toEqual({
      action: "skip",
      reason: "the co-op is no longer running",
    });
  });

  it("skips a wall-clock value, which a different repair owns", () => {
    const wallClock = auditRow({
      startTime: storedAt(9),
      endTime: storedAt(17),
    });

    // Planned from the same values, so it is the wall-clock check that
    // refuses it rather than the snapshot check below.
    expect(decideRepair(wallClock, wallClock, ON_COOP)).toEqual({
      action: "skip",
      reason: "the schedule now reads as a wall-clock value",
    });
  });

  it("skips a row whose values changed without date_modified moving", () => {
    // A raw UPDATE - or a console session - bypasses @updatedAt. The row
    // still passes every rule, and the planned repair was computed from the
    // value it replaced.
    const rewrittenRaw = auditRow({ startTime: storedAt(12) });

    expect(decideRepair(rewrittenRaw, PLANNED, ON_COOP)).toEqual({
      action: "skip",
      reason:
        "the schedule values changed since the plan was built without " +
        "date_modified moving",
    });
  });

  it("checks the end value as well as the start", () => {
    const rewrittenRaw = auditRow({ endTime: storedAt(20) });

    expect(decideRepair(rewrittenRaw, PLANNED, ON_COOP)).toMatchObject({
      action: "skip",
    });
  });

  it("skips a row whose date_modified moved but is still inside the window", () => {
    // Still provable on its own timestamps, but no longer the row the repair
    // was computed from.
    const resaved = auditRow({
      dateModified: new Date("2026-07-20T12:00:00.000Z"),
    });

    expect(decideRepair(resaved, PLANNED, ON_COOP)).toEqual({
      action: "skip",
      reason: "date_modified has moved since the plan was built",
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
  const planned = auditRow({
    dateModified: new Date("2026-07-15T12:34:56.789Z"),
  });
  const stmt = (stampedAt: Date = STAMP) =>
    repairStatement(
      planned,
      { startTime: storedAt(14), endTime: storedAt(22) },
      stampedAt,
    );
  const clauses = () => {
    const [set, where] = stmt().sql.split(/WHERE/i);
    return { set, where };
  };

  // Structural, because no behavioural test can see these. A statement that
  // dropped the date_modified assignment would still repair the row; it would
  // just silently stop being safe to re-run. One that dropped a WHERE term
  // would still repair the row; it would just silently stop being a
  // compare-and-swap. `repair-dst-schedule-times.db.test.ts` proves the same
  // statement against MySQL.
  it("assigns date_modified, because raw SQL bypasses @updatedAt", () => {
    expect(clauses().set).toMatch(/date_modified\s*=\s*\?/);
  });

  it("puts date_modified in the WHERE, which is what makes it a swap", () => {
    const { where } = clauses();

    expect(where).toBeDefined();
    expect(where).toMatch(/date_modified\s*=\s*\?/);
    expect(where).toMatch(/id\s*=\s*\?/);
  });

  it("puts both prior values in the WHERE, because not every write moves date_modified", () => {
    const { where } = clauses();

    expect(where).toMatch(/start_time\s*=\s*\?/);
    expect(where).toMatch(/end_time\s*=\s*\?/);
  });

  it("binds the stamp, the plan's date_modified and the plan's values as parameters", () => {
    expect(stmt().values).toEqual([
      "14:00:00",
      "22:00:00",
      "2026-11-17 15:00:00.123",
      "cs_1",
      "2026-07-15 12:34:56.789",
      "13:00:00",
      "21:00:00",
    ]);
  });

  it("writes both columns in the one statement", () => {
    expect(clauses().set).toMatch(/start_time\s*=/);
    expect(clauses().set).toMatch(/end_time\s*=/);
  });

  it.each([
    ["at the fix cutoff", SCHEDULE_FIX_DEPLOYED_AT],
    ["before it", new Date("2026-08-01T00:00:00.000Z")],
  ])(
    "refuses a stamp %s, which would leave the row selectable",
    (_label, stampedAt) => {
      expect(() => stmt(stampedAt)).toThrow(/refusing to stamp/);
    },
  );

  it("refuses a planned row with no schedule rather than binding null", () => {
    expect(() =>
      repairStatement(
        auditRow({ startTime: null }),
        { startTime: storedAt(14), endTime: storedAt(22) },
        STAMP,
      ),
    ).toThrow(/no schedule/);
  });
});

describe("maxRefusalMessage", () => {
  it("states the count and the ceiling", () => {
    const message = maxRefusalMessage(412, 300);

    expect(message).toContain("412 candidate(s) exceeds --max 300");
  });

  it("quotes no population figure of its own, which would go stale", () => {
    // It once said "210 rows matched when this was written" - wrong when it
    // shipped and only ever drifting further. The only numbers in the message
    // are the two it was handed.
    expect(maxRefusalMessage(412, 300).match(/\d+/g)).toEqual(["412", "300"]);
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

  it("keys the rollback on the run's stamp and covers rows a crash left uncertain", () => {
    // "Rows marked repaired" misses a row written just before a crash, and a
    // value-only predicate reverts an owner who retyped the canonical value.
    const { rollback } = buildManifest([candidate("cs_1")], meta);

    expect(rollback).toMatch(/date_modified = <repairStampedAt>/);
    expect(rollback).toMatch(/'in-flight'/);
    expect(rollback).toMatch(/'failed'/);
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

const freshDir = () => mkdtempSync(join(tmpdir(), "dst-manifest-"));

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(path, "utf8")) as Manifest;

describe("writeManifest, interrupted", () => {
  afterEach(() => jest.restoreAllMocks());

  it("leaves nothing at the path when the write fails part-way", () => {
    // A half-written file at the manifest's name would block the next run
    // from using that name and look like a record when it is not one.
    const dir = freshDir();
    const path = join(dir, "run.json");
    jest.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("no space left on device"), {
        code: "ENOSPC",
      });
    });

    expect(() =>
      writeManifest(path, buildManifest([candidate("cs_1")], META)),
    ).toThrow(/no space/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves no sibling file behind after a successful create", () => {
    const dir = freshDir();
    writeManifest(join(dir, "run.json"), buildManifest([], META));

    expect(readdirSync(dir)).toEqual(["run.json"]);
  });

  it("creates the file at 0600 whatever the umask would have made of it", () => {
    // 0277 strips the owner's write bit, so an `open` mode alone gives 0400.
    // The directory is made first: under that umask it would be unwritable.
    const path = join(freshDir(), "run.json");
    const previous = process.umask(0o277);
    try {
      writeManifest(path, buildManifest([], META));

      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });
});

describe("replaceManifest", () => {
  afterEach(() => jest.restoreAllMocks());

  /** A created manifest at `run.json`, and the bytes it was created with. */
  const created = () => {
    const dir = freshDir();
    const path = join(dir, "run.json");
    const manifest = buildManifest([candidate("cs_1")], META);
    writeManifest(path, manifest);
    return { dir, path, manifest, before: readFileSync(path, "utf8") };
  };

  it("replaces the contents with the new record", () => {
    const { path, manifest } = created();
    recordOutcome(manifest, "cs_1", "repaired");

    replaceManifest(path, manifest);

    expect(readManifest(path).rows[0].outcome).toBe("repaired");
  });

  it("preserves the permission bits the file already has", () => {
    // An operator who tightened the record mid-run keeps it tightened.
    const { path, manifest } = created();
    chmodSync(path, 0o400);

    replaceManifest(path, manifest);

    expect(statSync(path).mode & 0o777).toBe(0o400);
  });

  it("keeps 0600 across replacements", () => {
    const { path, manifest } = created();
    replaceManifest(path, manifest);
    replaceManifest(path, manifest);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to recreate a manifest that has gone missing", () => {
    const { dir, path, manifest } = created();
    fs.rmSync(path);

    expect(() => replaceManifest(path, manifest)).toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual([]);
  });

  // Every step before the rename, failing in turn. Whichever one it is, the
  // previous record must be byte-for-byte what it was, at the mode it had,
  // with no partial sibling left beside it. A truncate-and-rewrite fails the
  // first of these: the target is empty the moment the write is opened.
  it.each([
    ["opening the sibling", "openSync"],
    ["setting its mode", "fchmodSync"],
    ["flushing it to disk", "fsyncSync"],
    ["closing it", "closeSync"],
    ["renaming it into place", "renameSync"],
  ] as const)("keeps the last valid record when %s fails", (_step, fn) => {
    const { dir, path, manifest, before } = created();
    recordOutcome(manifest, "cs_1", "repaired");
    jest.spyOn(fs, fn).mockImplementationOnce(() => {
      throw new Error(`injected ${fn} failure`);
    });

    expect(() => replaceManifest(path, manifest)).toThrow(/injected/);

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readManifest(path).rows[0].outcome).toBe("pending");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["run.json"]);
  });

  it("keeps the last valid record when the write itself stops half-way", () => {
    // The disk filling mid-write: some bytes land, then the call throws.
    const { dir, path, manifest, before } = created();
    recordOutcome(manifest, "cs_1", "repaired");
    const realWrite = fs.writeFileSync;
    jest.spyOn(fs, "writeFileSync").mockImplementationOnce((target, data) => {
      realWrite(target, String(data).slice(0, 40));
      throw Object.assign(new Error("no space left on device"), {
        code: "ENOSPC",
      });
    });

    expect(() => replaceManifest(path, manifest)).toThrow(/no space/);

    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["run.json"]);
  });

  it("is not thrown by a sibling a killed process left behind", () => {
    // SIGKILL between writing the sibling and renaming it leaves an orphan.
    // It must not block the next replace or be mistaken for the record.
    const { dir, path, manifest } = created();
    writeFileSync(join(dir, ".run.json.99999.deadbeef0000.tmp"), '{"rows": [');
    recordOutcome(manifest, "cs_1", "repaired");

    replaceManifest(path, manifest);

    expect(readManifest(path).rows[0].outcome).toBe("repaired");
  });
});

/**
 * A `carpool_search` table of one column set, applying `repairStatement`'s
 * compare-and-swap the way MySQL would. The real semantics are proven in
 * `repair-dst-schedule-times.db.test.ts`; this exists so the loop's ordering
 * - what is on disk at each point a run can die - can be tested here.
 */
const fakeStore = (
  rows: ScheduleTimeAuditRow[],
  hooks: {
    /** Runs after the re-read and before the statement - a concurrent save. */
    beforeExecute?: (searchId: string) => void;
    /** Throws from `execute` for this id, after applying it when `committed`. */
    failOn?: { searchId: string; committed: boolean };
  } = {},
) => {
  const table = new Map(rows.map((row) => [row.id, { ...row }]));
  const executed: string[] = [];

  const toTime = (sql: string) => {
    const [h, m, s] = sql.split(":").map(Number);
    return new Date(Date.UTC(1970, 0, 1, h, m, s));
  };

  const store: RepairStore = {
    readRow: async (searchId) => {
      const row = table.get(searchId);
      return row ? { ...row } : null;
    },
    execute: async (statement: Prisma.Sql) => {
      const [start, end, stamp, id, dateModified, priorStart, priorEnd] =
        statement.values as string[];
      executed.push(id);
      hooks.beforeExecute?.(id);

      const row = table.get(id);
      const matches =
        row !== undefined &&
        row.startTime !== null &&
        row.endTime !== null &&
        toSqlDateTime(row.dateModified) === dateModified &&
        toSqlTime(row.startTime) === priorStart &&
        toSqlTime(row.endTime) === priorEnd;

      const fail = hooks.failOn?.searchId === id ? hooks.failOn : undefined;
      if (matches && (!fail || fail.committed)) {
        row.startTime = toTime(start);
        row.endTime = toTime(end);
        row.dateModified = new Date(`${stamp.replace(" ", "T")}Z`);
      }
      if (fail) {
        // One-shot, so a re-run against the same table is not failed again.
        hooks.failOn = undefined;
        throw new Error("connection lost");
      }

      return matches ? 1 : 0;
    },
  };

  return { store, table, executed };
};

/** Stamps one millisecond apart, past the fix cutoff. */
const steppingClock = () => {
  let at = STAMP.getTime();
  return () => new Date(at++);
};

/** A run over `ids`, with its manifest created on disk as `main` does. */
const plannedRun = (ids: string[]) => {
  const candidates = ids.map(candidate);
  const manifest = buildManifest(candidates, {
    asOf: ON_COOP,
    mode: "apply",
    now: STAMP,
  });
  const manifestFile = join(freshDir(), "run.json");
  writeManifest(manifestFile, manifest);
  return { candidates, manifest, manifestFile };
};

const silent = () => undefined;

describe("applyRepairs", () => {
  afterEach(() => jest.restoreAllMocks());

  it("repairs every candidate and records each with the stamp it wrote", async () => {
    const run = plannedRun(["cs_a", "cs_b"]);
    const { store, table } = fakeStore(run.candidates.map((c) => c.row));

    const result = await applyRepairs({
      store,
      ...run,
      asOf: ON_COOP,
      requireApprovedCore: false,
      clock: steppingClock(),
      log: silent,
    });

    expect(result).toEqual({ repaired: 2, skipped: 0, lostRace: 0 });
    const onDisk = readManifest(run.manifestFile);
    expect(onDisk.rows.map((row) => row.outcome)).toEqual([
      "repaired",
      "repaired",
    ]);
    for (const entry of onDisk.rows) {
      const row = table.get(entry.searchId);
      expect(toSqlTime(row?.startTime as Date)).toBe(entry.proposedStartTime);
      expect(row?.dateModified.toISOString()).toBe(entry.repairStampedAt);
    }
  });

  describe("stale schedule values", () => {
    it("skips a row whose values changed without date_modified moving, and never sends it", async () => {
      const run = plannedRun(["cs_a"]);
      const stale = { ...run.candidates[0].row, startTime: storedAt(12) };
      const { store, table, executed } = fakeStore([stale]);

      const result = await applyRepairs({
        store,
        ...run,
        asOf: ON_COOP,
        requireApprovedCore: false,
        clock: steppingClock(),
        log: silent,
      });

      expect(result).toEqual({ repaired: 0, skipped: 1, lostRace: 0 });
      expect(executed).toEqual([]);
      expect(toSqlTime(table.get("cs_a")?.startTime as Date)).toBe("12:00:00");
      expect(readManifest(run.manifestFile).rows[0]).toMatchObject({
        outcome: "skipped",
        note: expect.stringMatching(/values changed/),
      });
    });

    it("loses the race to a raw write that lands after the re-read", async () => {
      // The re-read saw the planned values; a write that does not touch
      // date_modified changes them before the statement arrives. Only the
      // value predicates in the WHERE can refuse this one.
      const run = plannedRun(["cs_a"]);
      const { store, table } = fakeStore(
        run.candidates.map((c) => c.row),
        {
          beforeExecute: (id) => {
            const row = table.get(id);
            if (row) row.endTime = storedAt(20);
          },
        },
      );

      const result = await applyRepairs({
        store,
        ...run,
        asOf: ON_COOP,
        requireApprovedCore: false,
        clock: steppingClock(),
        log: silent,
      });

      expect(result).toEqual({ repaired: 0, skipped: 0, lostRace: 1 });
      expect(toSqlTime(table.get("cs_a")?.startTime as Date)).toBe("13:00:00");
      expect(toSqlTime(table.get("cs_a")?.endTime as Date)).toBe("20:00:00");
      expect(readManifest(run.manifestFile).rows[0].outcome).toBe("lost-race");
    });
  });

  describe("a partially completed batch", () => {
    it("stops on a failed statement with every row's state on disk", async () => {
      const run = plannedRun(["cs_a", "cs_b", "cs_c"]);
      const { store, table } = fakeStore(
        run.candidates.map((c) => c.row),
        { failOn: { searchId: "cs_b", committed: false } },
      );

      await expect(
        applyRepairs({
          store,
          ...run,
          asOf: ON_COOP,
          requireApprovedCore: false,
          clock: steppingClock(),
          log: silent,
        }),
      ).rejects.toThrow(/connection lost/);

      const rows = readManifest(run.manifestFile).rows;
      expect(rows.map((row) => row.outcome)).toEqual([
        "repaired",
        "failed",
        "pending",
      ]);
      expect(rows[1].note).toMatch(/^outcome unknown/);
      // The failed row keeps its stamp, so the rollback can test whether the
      // write landed. The unreached row was never stamped.
      expect(rows[1].repairStampedAt).toBeDefined();
      expect(rows[2].repairStampedAt).toBeUndefined();
      expect(toSqlTime(table.get("cs_c")?.startTime as Date)).toBe("13:00:00");
    });

    it("leaves a row written just before a crash identifiable as in-flight", async () => {
      // The statement commits and the process dies before the flush that
      // would record it. Simulated by failing the rename of that flush: the
      // second row's in-flight flush is rename 3, its outcome flush rename 4.
      const run = plannedRun(["cs_a", "cs_b", "cs_c"]);
      const { store, table } = fakeStore(run.candidates.map((c) => c.row));
      const realRename = fs.renameSync;
      let renames = 0;
      jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (++renames === 4) throw new Error("killed");
        realRename(from, to);
      });

      await expect(
        applyRepairs({
          store,
          ...run,
          asOf: ON_COOP,
          requireApprovedCore: false,
          clock: steppingClock(),
          log: silent,
        }),
      ).rejects.toThrow(/killed/);

      // The last valid record, intact, and it tells the truth: cs_b's write
      // is not claimed, but its stamp is there and matches the row.
      const rows = readManifest(run.manifestFile).rows;
      expect(rows.map((row) => row.outcome)).toEqual([
        "repaired",
        "in-flight",
        "pending",
      ]);
      expect(table.get("cs_b")?.dateModified.toISOString()).toBe(
        rows[1].repairStampedAt,
      );
      expect(toSqlTime(table.get("cs_b")?.startTime as Date)).toBe(
        rows[1].proposedStartTime,
      );
    });

    it("sends nothing when the write-ahead flush fails", async () => {
      // The stamp could not be recorded, so the row must not be written.
      const run = plannedRun(["cs_a"]);
      const { store, executed } = fakeStore(run.candidates.map((c) => c.row));
      jest.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw new Error("disk gone");
      });

      await expect(
        applyRepairs({
          store,
          ...run,
          asOf: ON_COOP,
          requireApprovedCore: false,
          clock: steppingClock(),
          log: silent,
        }),
      ).rejects.toThrow(/disk gone/);

      expect(executed).toEqual([]);
      expect(readManifest(run.manifestFile).rows[0].outcome).toBe("pending");
    });

    it("refuses a stamp at or before the cutoff before recording or sending anything", async () => {
      const run = plannedRun(["cs_a"]);
      const { store, executed } = fakeStore(run.candidates.map((c) => c.row));

      await expect(
        applyRepairs({
          store,
          ...run,
          asOf: ON_COOP,
          requireApprovedCore: false,
          clock: () => new Date("2026-08-01T00:00:00.000Z"),
          log: silent,
        }),
      ).rejects.toThrow(/refusing to stamp/);

      expect(executed).toEqual([]);
      expect(readManifest(run.manifestFile).rows[0].outcome).toBe("pending");
    });
  });

  describe("recovering from a partially completed batch", () => {
    /** The plan a re-run would build from the table as it now stands. */
    const replan = (table: Map<string, ScheduleTimeAuditRow>) =>
      findDstWrittenScheduleRows([...table.values()], ON_COOP).map(
        (entry) => entry.row.id,
      );

    it.each([
      ["did not commit", false, ["cs_b", "cs_c"]],
      ["committed before the connection dropped", true, ["cs_c"]],
    ])(
      "a re-run picks up exactly the rows not yet written when the failed statement %s",
      async (_label, committed, expected) => {
        const first = plannedRun(["cs_a", "cs_b", "cs_c"]);
        const { store, table } = fakeStore(
          first.candidates.map((c) => c.row),
          { failOn: { searchId: "cs_b", committed } },
        );

        await expect(
          applyRepairs({
            store,
            ...first,
            asOf: ON_COOP,
            requireApprovedCore: false,
            clock: steppingClock(),
            log: silent,
          }),
        ).rejects.toThrow();

        // Written rows carry a stamp past the cutoff and are not selectable;
        // whatever the manifest managed to record, the table decides.
        expect(replan(table)).toEqual(expected);

        // The re-run, with a new manifest, finishes the job and nothing is
        // repaired twice.
        const remaining = findDstWrittenScheduleRows(
          [...table.values()],
          ON_COOP,
        );
        const manifest = buildManifest(remaining, {
          asOf: ON_COOP,
          mode: "apply",
          now: STAMP,
        });
        const manifestFile = join(freshDir(), "rerun.json");
        writeManifest(manifestFile, manifest);
        const second = await applyRepairs({
          store,
          candidates: remaining,
          manifest,
          manifestFile,
          asOf: ON_COOP,
          requireApprovedCore: false,
          clock: steppingClock(),
          log: silent,
        });

        expect(second.repaired).toBe(expected.length);
        expect(replan(table)).toEqual([]);
        for (const row of table.values()) {
          expect(toSqlTime(row.startTime as Date)).toBe("14:00:00");
          expect(toSqlTime(row.endTime as Date)).toBe("22:00:00");
        }
      },
    );

    it("the first run's record identifies every row it wrote, including the uncertain one", async () => {
      // The rollback predicate the manifest documents, applied to the table:
      // proposed values plus the recorded stamp.
      const run = plannedRun(["cs_a", "cs_b", "cs_c"]);
      const { store, table } = fakeStore(
        run.candidates.map((c) => c.row),
        { failOn: { searchId: "cs_b", committed: true } },
      );
      await expect(
        applyRepairs({
          store,
          ...run,
          asOf: ON_COOP,
          requireApprovedCore: false,
          clock: steppingClock(),
          log: silent,
        }),
      ).rejects.toThrow();

      const rollbackMatches = readManifest(run.manifestFile)
        .rows.filter((entry) =>
          ["repaired", "in-flight", "failed"].includes(entry.outcome),
        )
        .filter((entry) => {
          const row = table.get(entry.searchId);
          return (
            entry.repairStampedAt !== undefined &&
            row !== undefined &&
            toSqlTime(row.startTime as Date) === entry.proposedStartTime &&
            toSqlTime(row.endTime as Date) === entry.proposedEndTime &&
            row.dateModified.toISOString() === entry.repairStampedAt
          );
        })
        .map((entry) => entry.searchId);

      expect(rollbackMatches).toEqual(["cs_a", "cs_b"]);
    });
  });
});

describe("applyRepairs on a canary, when the row leaves the approved scope after selection", () => {
  afterEach(() => jest.restoreAllMocks());

  /**
   * Each change happens after `selectOnly` accepted the row and before the
   * loop re-reads it, and none of them touches `date_modified` or the two
   * schedule values — so `decideRepair` and the compare-and-swap both pass
   * it, and only the approved-core re-check stands in the way.
   */
  const scopeChanges: [string, Partial<ScheduleTimeAuditRow>, RegExp][] = [
    ["becomes a VIEWER", { role: "VIEWER" }, /now a VIEWER/],
    ["is no longer ACTIVE", { status: "INACTIVE" }, /now INACTIVE/],
    [
      "no longer reads as never edited",
      // Still inside the 2026 EDT window, so the span rule still holds.
      { dateCreated: new Date("2026-06-01T12:00:00.000Z") },
      /no longer reads as never edited/,
    ],
  ];

  /** A one-row canary whose row is changed by `change` after selection. */
  const canaryRun = (change: Partial<ScheduleTimeAuditRow>) => {
    const run = plannedRun(["cs_a"]);
    const selection = selectOnly(run.candidates, ["cs_a"]);
    expect(selection.ok).toBe(true);

    const changed = { ...run.candidates[0].row, ...change };
    return { run, ...fakeStore([changed]) };
  };

  it("repairs the row when nothing has changed, which is what makes the skips below meaningful", async () => {
    const { run, store, executed } = canaryRun({});

    const result = await applyRepairs({
      store,
      ...run,
      asOf: ON_COOP,
      requireApprovedCore: true,
      clock: steppingClock(),
      log: silent,
    });

    expect(result).toEqual({ repaired: 1, skipped: 0, lostRace: 0 });
    expect(executed).toEqual(["cs_a"]);
  });

  it.each(scopeChanges)(
    "skips a row that %s, sends nothing and records why",
    async (_label, change, reason) => {
      const { run, store, table, executed } = canaryRun(change);

      const result = await applyRepairs({
        store,
        ...run,
        asOf: ON_COOP,
        requireApprovedCore: true,
        clock: steppingClock(),
        log: silent,
      });

      expect(result).toEqual({ repaired: 0, skipped: 1, lostRace: 0 });
      expect(executed).toEqual([]);
      expect(toSqlTime(table.get("cs_a")?.startTime as Date)).toBe("13:00:00");
      expect(toSqlTime(table.get("cs_a")?.endTime as Date)).toBe("21:00:00");
      expect(table.get("cs_a")?.dateModified).toEqual(EDT_2026_JULY);
      // Refused before the write-ahead step, so no stamp was ever recorded
      // and the rollback has nothing to match.
      const entry = readManifest(run.manifestFile).rows[0];
      expect(entry).toMatchObject({
        outcome: "skipped",
        note: expect.stringMatching(reason),
      });
      expect(entry.repairStampedAt).toBeUndefined();
    },
  );

  it.each(scopeChanges)(
    "still repairs a row that %s on a full run, whose scope is the span rule",
    async (_label, change) => {
      // The control: the full run is unchanged, and the skip above comes
      // from the approved-core re-check rather than from `decideRepair`.
      const { run, store, executed } = canaryRun(change);

      const result = await applyRepairs({
        store,
        ...run,
        asOf: ON_COOP,
        requireApprovedCore: false,
        clock: steppingClock(),
        log: silent,
      });

      expect(result).toEqual({ repaired: 1, skipped: 0, lostRace: 0 });
      expect(executed).toEqual(["cs_a"]);
    },
  );

  it("skips a row edited after selection, which the DST re-check already refuses", async () => {
    // The realistic way out of "never edited": the owner saves, and
    // `date_modified` moves. `decideRepair` gives the reason, being first.
    const { run, store, executed } = canaryRun({
      dateModified: new Date("2026-08-15T12:00:00.000Z"),
    });

    const result = await applyRepairs({
      store,
      ...run,
      asOf: ON_COOP,
      requireApprovedCore: true,
      clock: steppingClock(),
      log: silent,
    });

    expect(result).toEqual({ repaired: 0, skipped: 1, lostRace: 0 });
    expect(executed).toEqual([]);
    expect(readManifest(run.manifestFile).rows[0].note).toMatch(
      /date_modified has moved/,
    );
  });

  it("catches a row flipped while an earlier row in the same canary is being written", async () => {
    const run = plannedRun(["cs_a", "cs_b", "cs_c"]);
    expect(selectOnly(run.candidates, ["cs_a", "cs_b", "cs_c"]).ok).toBe(true);
    const { store, table, executed } = fakeStore(
      run.candidates.map((c) => c.row),
      {
        beforeExecute: (id) => {
          const next = table.get("cs_b");
          if (id === "cs_a" && next) next.status = "INACTIVE";
        },
      },
    );

    const result = await applyRepairs({
      store,
      ...run,
      asOf: ON_COOP,
      requireApprovedCore: true,
      clock: steppingClock(),
      log: silent,
    });

    expect(result).toEqual({ repaired: 2, skipped: 1, lostRace: 0 });
    expect(executed).toEqual(["cs_a", "cs_c"]);
    expect(toSqlTime(table.get("cs_b")?.startTime as Date)).toBe("13:00:00");
    expect(
      readManifest(run.manifestFile).rows.map((row) => row.outcome),
    ).toEqual(["repaired", "skipped", "repaired"]);
  });
});

describe("decideApprovedCore", () => {
  it("names the criterion that failed", () => {
    expect(decideApprovedCore(auditRow())).toEqual({ action: "repair" });
    expect(decideApprovedCore(auditRow({ role: "VIEWER" }))).toEqual({
      action: "skip",
      reason: expect.stringMatching(/now a VIEWER/),
    });
    expect(decideApprovedCore(auditRow({ status: "INACTIVE" }))).toEqual({
      action: "skip",
      reason: expect.stringMatching(/now INACTIVE/),
    });
    expect(
      decideApprovedCore(
        auditRow({ dateCreated: new Date("2026-06-01T12:00:00.000Z") }),
      ),
    ).toEqual({
      action: "skip",
      reason: expect.stringMatching(/never edited/),
    });
  });

  it("agrees with isApprovedCoreRow, which selection uses", () => {
    const rows = [
      auditRow(),
      auditRow({ role: "RIDER" }),
      auditRow({ role: "VIEWER" }),
      auditRow({ status: "INACTIVE" }),
      auditRow({ dateModified: new Date("2026-08-15T12:00:00.000Z") }),
    ];

    for (const row of rows) {
      expect(isApprovedCoreRow(row)).toBe(
        decideApprovedCore(row).action === "repair",
      );
    }
  });
});

describe("isApprovedCoreRow", () => {
  it("accepts a never-edited ACTIVE rider or driver, which is SCRUM-725's approved scope", () => {
    expect(isApprovedCoreRow(auditRow({ role: "DRIVER" }))).toBe(true);
    expect(isApprovedCoreRow(auditRow({ role: "RIDER" }))).toBe(true);
  });

  it("refuses a VIEWER, whom SCRUM-725's cohort excluded", () => {
    expect(isApprovedCoreRow(auditRow({ role: "VIEWER" }))).toBe(false);
  });

  it("refuses an INACTIVE row", () => {
    expect(isApprovedCoreRow(auditRow({ status: "INACTIVE" }))).toBe(false);
  });

  it("refuses a row edited after creation, which only the wider span rule reaches", () => {
    const at = EDT_2026_JULY.getTime();

    expect(
      isApprovedCoreRow(
        auditRow({
          dateModified: new Date(at + NEVER_EDITED_TOLERANCE_MS),
        }),
      ),
    ).toBe(true);
    expect(
      isApprovedCoreRow(
        auditRow({
          dateModified: new Date(at + NEVER_EDITED_TOLERANCE_MS + 1),
        }),
      ),
    ).toBe(false);
  });
});

describe("extractOnlyIds", () => {
  it("pulls the list out and leaves the rest for the other parsers", () => {
    expect(
      extractOnlyIds([
        "--only",
        "cs_a,cs_b",
        "--apply",
        "--manifest",
        "c.json",
      ]),
    ).toEqual({
      onlyIds: ["cs_a", "cs_b"],
      rest: ["--apply", "--manifest", "c.json"],
    });
  });

  it("returns no list when the flag is absent, so the full run is unchanged", () => {
    expect(extractOnlyIds(["--apply"])).toEqual({
      onlyIds: null,
      rest: ["--apply"],
    });
  });

  it("throws rather than swallowing the next flag as the list", () => {
    expect(() => extractOnlyIds(["--only", "--apply"])).toThrow(
      /--only expects/,
    );
    expect(() => extractOnlyIds(["--only"])).toThrow(/--only expects/);
  });

  it("refuses a second --only rather than merging or dropping one", () => {
    expect(() => extractOnlyIds(["--only", "cs_a", "--only", "cs_b"])).toThrow(
      /more than once/,
    );
  });

  it.each([[""], ["cs_a,"], ["cs_a,,cs_b"], [" cs_a"], ["cs_a;DROP"]])(
    "refuses a malformed list %j",
    (value) => {
      expect(() => extractOnlyIds(["--only", value])).toThrow(/malformed/);
    },
  );

  it("leaves an unknown argument for the shared parser to reject", () => {
    const { rest } = extractOnlyIds(["--only", "cs_a", "--canary"]);

    expect(() => parseArgs(rest)).toThrow(/unknown argument/);
  });

  it("composes with --manifest in either order", () => {
    const argv = ["--manifest", "c.json", "--only", "cs_a", "--apply"];
    const { onlyIds, rest } = extractOnlyIds(argv);
    const { manifestPath, rest: remaining } = extractManifestPath(rest);

    expect(onlyIds).toEqual(["cs_a"]);
    expect(manifestPath).toBe("c.json");
    expect(parseArgs(remaining)).toEqual({ apply: true, max: 300 });
  });
});

describe("selectOnly", () => {
  const ids = ["cs_1", "cs_2", "cs_3", "cs_4", "cs_5", "cs_6", "cs_7"];
  const pool = ids.map(candidate);

  const problemsOf = (result: ReturnType<typeof selectOnly>): string[] =>
    result.ok ? [] : result.problems;

  it("selects exactly the named rows, in candidate order whatever order they were typed", () => {
    const result = selectOnly(pool, ["cs_4", "cs_1", "cs_3"]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.selected.map((c) => c.row.id)).toEqual([
      "cs_1",
      "cs_3",
      "cs_4",
    ]);
  });

  it("accepts exactly CANARY_MAX ids", () => {
    expect(CANARY_MAX).toBe(5);
    expect(selectOnly(pool, ids.slice(0, CANARY_MAX)).ok).toBe(true);
  });

  it("refuses more than CANARY_MAX ids, even when every one is eligible", () => {
    const result = selectOnly(pool, ids.slice(0, CANARY_MAX + 1));

    expect(result.ok).toBe(false);
    expect(problemsOf(result).join("\n")).toMatch(/exceeds the canary limit/);
  });

  it("refuses an id that is not a current candidate, and selects none of the others", () => {
    const result = selectOnly(pool, ["cs_1", "cs_missing"]);

    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toEqual([
      expect.stringMatching(/^cs_missing is not a current candidate/),
    ]);
  });

  it.each([
    ["a VIEWER", { role: "VIEWER" }, /VIEWER, ACTIVE, never edited/],
    [
      "an INACTIVE row",
      { status: "INACTIVE" },
      /DRIVER, INACTIVE, never edited/,
    ],
    [
      "a row edited after creation",
      { dateModified: new Date("2026-08-15T12:00:00.000Z") },
      /DRIVER, ACTIVE, edited after creation/,
    ],
  ])(
    "refuses %s even though the full rule selects it",
    (_label, overrides, reason) => {
      const outside: DstScheduleRow = {
        ...candidate("cs_out"),
        row: auditRow({ id: "cs_out", ...overrides }),
      };
      // Precondition: the wide rule really does select it, so the refusal
      // comes from the scope check and not from the row being ineligible.
      expect(findDstWrittenScheduleRows([outside.row], ON_COOP)).toHaveLength(
        1,
      );

      const result = selectOnly([...pool, outside], ["cs_1", "cs_out"]);

      expect(result.ok).toBe(false);
      expect(problemsOf(result)).toEqual([
        expect.stringMatching(/^cs_out is a candidate but outside SCRUM-725/),
      ]);
      expect(problemsOf(result)[0]).toMatch(reason);
    },
  );

  it("refuses duplicates", () => {
    const result = selectOnly(pool, ["cs_1", "cs_1"]);

    expect(problemsOf(result)).toEqual([
      expect.stringMatching(/duplicate id\(s\): cs_1/),
    ]);
  });

  it("refuses an empty list", () => {
    expect(problemsOf(selectOnly(pool, []))).toEqual(["--only names no ids"]);
  });

  it("reports every problem at once, so one correction fixes the command", () => {
    const result = selectOnly(pool, [
      "cs_1",
      "cs_1",
      "cs_x",
      "cs_y",
      "cs_2",
      "cs_3",
      "cs_4",
    ]);

    // Duplicate, over the limit (6 distinct), and two unknown ids.
    expect(problemsOf(result)).toHaveLength(4);
  });

  it("refuses everything against an empty candidate set", () => {
    const result = selectOnly([], ["cs_1"]);

    expect(problemsOf(result)).toEqual([
      expect.stringMatching(/^cs_1 is not a current candidate/),
    ]);
  });
});

describe("buildManifest, --only", () => {
  it("records the selection and describes only the selected rows", () => {
    const manifest = buildManifest([candidate("cs_1")], {
      ...META,
      selection: { only: ["cs_1"], fullCandidateCount: 221 },
    });

    expect(manifest.candidateCount).toBe(1);
    expect(manifest.rows.map((row) => row.searchId)).toEqual(["cs_1"]);
    expect(manifest.selection).toEqual({
      only: ["cs_1"],
      fullCandidateCount: 221,
    });
  });

  it("carries no selection key on a full run", () => {
    expect(buildManifest([candidate("cs_1")], META)).not.toHaveProperty(
      "selection",
    );
  });
});

describe("a canary, then re-runs", () => {
  /**
   * Seven core rows, a VIEWER and a row edited after creation — all nine of
   * which the full rule selects. Driven through the real selection rule,
   * `selectOnly`, `applyRepairs` and a table that applies the real
   * statement, so each re-run plans from what the previous one left behind.
   */
  const table = () => {
    const core = ["cs_1", "cs_2", "cs_3", "cs_4", "cs_5", "cs_6", "cs_7"].map(
      (id) => auditRow({ id }),
    );
    return [
      ...core,
      auditRow({ id: "cs_viewer", role: "VIEWER" }),
      auditRow({
        id: "cs_edited",
        dateModified: new Date("2026-08-15T12:00:00.000Z"),
      }),
    ];
  };

  const CANARY = ["cs_2", "cs_4", "cs_5", "cs_6", "cs_7"];

  const plan = (rows: Iterable<ScheduleTimeAuditRow>) =>
    sortById(findDstWrittenScheduleRows([...rows], ON_COOP));

  const run = async (
    store: RepairStore,
    candidates: DstScheduleRow[],
    requireApprovedCore: boolean,
    clock: () => Date,
  ) => {
    const manifest = buildManifest(candidates, META);
    const manifestFile = join(freshDir(), "run.json");
    writeManifest(manifestFile, manifest);
    const result = await applyRepairs({
      store,
      candidates,
      manifest,
      manifestFile,
      asOf: ON_COOP,
      requireApprovedCore,
      clock,
      log: silent,
    });
    return { result, manifestFile };
  };

  it("repairs exactly the canary rows and leaves every other row untouched", async () => {
    const rows = table();
    expect(plan(rows)).toHaveLength(9);

    const selection = selectOnly(plan(rows), CANARY);
    if (!selection.ok) throw new Error(selection.problems.join("; "));

    const { store, table: db, executed } = fakeStore(rows);
    const { result, manifestFile } = await run(
      store,
      selection.selected,
      true,
      steppingClock(),
    );

    expect(result).toEqual({ repaired: 5, skipped: 0, lostRace: 0 });
    expect(executed).toEqual(CANARY);
    expect(readManifest(manifestFile).rows.map((r) => r.searchId)).toEqual(
      CANARY,
    );
    for (const [id, row] of db) {
      expect([id, toSqlTime(row.startTime as Date)]).toEqual([
        id,
        CANARY.includes(id) ? "14:00:00" : "13:00:00",
      ]);
    }
  });

  it("refuses a re-run of the same canary command instead of picking other rows", async () => {
    const { store, table: db } = fakeStore(table());
    const first = selectOnly(plan(db.values()), CANARY);
    if (!first.ok) throw new Error(first.problems.join("; "));
    await run(store, first.selected, true, steppingClock());

    const again = selectOnly(plan(db.values()), CANARY);

    expect(again.ok).toBe(false);
    expect(problemsOf(again)).toHaveLength(CANARY.length);
    for (const problem of problemsOf(again)) {
      expect(problem).toMatch(/is not a current candidate/);
    }
  });

  it("lets the full run that follows pick up every remaining row and none of the canary", async () => {
    const { store, table: db, executed } = fakeStore(table());
    const canary = selectOnly(plan(db.values()), CANARY);
    if (!canary.ok) throw new Error(canary.problems.join("; "));
    const clock = steppingClock();
    await run(store, canary.selected, true, clock);
    executed.length = 0;

    const remaining = plan(db.values());
    expect(remaining.map((c) => c.row.id)).toEqual([
      "cs_1",
      "cs_3",
      "cs_edited",
      "cs_viewer",
    ]);

    // A full run: its scope is the span rule, so the VIEWER and the edited
    // row are repaired here even though no canary could reach them.
    const { result } = await run(store, remaining, false, clock);

    expect(result).toEqual({ repaired: 4, skipped: 0, lostRace: 0 });
    expect(executed).not.toEqual(expect.arrayContaining([CANARY[0]]));
    // Every row repaired exactly once: the canary rows were not shifted again.
    for (const row of db.values()) {
      expect(toSqlTime(row.startTime as Date)).toBe("14:00:00");
    }
    expect(plan(db.values())).toEqual([]);
  });

  const problemsOf = (result: ReturnType<typeof selectOnly>): string[] =>
    result.ok ? [] : result.problems;
});
