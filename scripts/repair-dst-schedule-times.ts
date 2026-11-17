/**
 * Repair the schedule times stored an hour early because they were converted
 * at EDT, for users whose co-op is running.
 *
 * Before the fixed anchor shipped, the write path converted at the offset in
 * force on the day the user saved, so a 9:00 AM picked in July was stored as
 * `13:00` where the convention now says `14:00`. Every surface reads these
 * back at the anchor, so they display and match an hour early.
 * `src/server/db/dstScheduleIntegrity.ts` owns which rows those are and what
 * each should have held; this script is the reads and the writes.
 *
 * **Scope, and why it is this narrow.** A stored value does not record the
 * offset that produced it — `13:00` is equally a correct 8:00 AM and an
 * incorrect 9:00 AM — so the hour alone can never justify a write. What makes
 * a row selectable is its timestamps: `dateCreated` is immutable, the schedule
 * must have been authored somewhere between it and `dateModified`, and when
 * that whole span sits inside one daylight-saving window, every instant it
 * could have been is EDT. Rows whose span crosses a transition keep the
 * original ambiguity and **are not touched**. Neither are rows the bulk load
 * stamped, rows from the era that stored a wall clock, or rows that might have
 * been saved through the fixed path.
 *
 * **The span proves the season, not the offset.** The pre-fix path stored an
 * instant resolved in the *browser's* zone, so season and offset coincide only
 * for somebody sitting in Eastern time. Rows whose `Location` rows do not
 * evidence that are excluded as well — see `isEasternOffsetEvidenced`.
 *
 * On production as measured on 2026-11-17: 324 live rows carry a schedule, 234
 * of those are pre-fix converting-era rows, 223 of *those* have a span that
 * proves the season, and **221** survive the Eastern-offset evidence check.
 * The 11 the span rule drops, and the 2 the offset check drops, need their
 * owners asked rather than guessed at.
 *
 * **The scope here is wider than SCRUM-725 authorised and that is a decision
 * somebody has to take.** That ticket approved a rule requiring `date_modified`
 * within five seconds of `date_created` — "never edited since creation", 90
 * rows — and put the rest explicitly out of scope. The span rule below is a
 * sound generalisation of it, but it is a generalisation: it reaches rows that
 * ticket said nothing may touch. Record the decision before `--apply`.
 *
 * Safety, because this writes to production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Every candidate is re-checked immediately before its own write, against
 *     a row read after the plan was built, so somebody who retyped their
 *     schedule in between keeps what they entered.
 *   - **The write itself is a compare-and-swap on the plan's snapshot** —
 *     `date_modified` *and* both schedule values exactly as the plan read
 *     them — so the re-check cannot be raced. The re-read above narrows the
 *     window; it does not close it, and a profile save landing inside it would
 *     otherwise be overwritten by a value computed from the stale read. The
 *     values are compared as well as the timestamp because nothing in the
 *     database makes a write advance `date_modified`: Prisma's `@updatedAt`
 *     does it for Prisma's own writes, and raw SQL — several of the existing
 *     `UPDATE carpool_search` statements, any console session — does not.
 *   - **A rollback manifest is written before the first write**, at mode
 *     `0600`, and updated as each row resolves. Both columns are overwritten
 *     in place and there is no history table, so without it a closed terminal
 *     is an unrecoverable repair. Every update is an atomic replace — a
 *     fsynced sibling file renamed over the old one — so a crash or a full
 *     disk mid-update leaves the previous complete record, never a truncated
 *     one.
 *   - **Write-ahead, per row.** The `date_modified` a row is about to be
 *     stamped with is recorded, as `in-flight`, before its statement is sent.
 *     A run that dies at any point therefore leaves every row it may have
 *     written identifiable: the rollback matches on that stamp, not on the
 *     outcome the run managed to record.
 *   - Refuses to proceed when the candidate count exceeds `--max`. The default
 *     is deliberately above the ~221 expected and well below a count that
 *     could only mean the rule is wrong.
 *   - **Prints the prior value of every row before touching it**, as well as
 *     recording it in the manifest.
 *   - Every candidate is listed, never sampled, and the ceiling is checked
 *     before that listing so a run that is going to refuse does not print
 *     hundreds of user ids on its way out.
 *   - One row per statement, both columns together, so an interrupted run
 *     never leaves a row with a repaired start and an unrepaired end.
 *
 * The repaired value is not "plus one hour" — it is whatever
 * `toStoredScheduleTime` produces for the digits the user typed, recovered by
 * reading the stored instant back at EDT. A repaired row is byte-identical to
 * what its owner would store by retyping their schedule today.
 *
 * **Re-running is safe, but not because the value stops matching.** A repaired
 * `13:00` becomes `14:00`, which the timestamp rule would still accept. What
 * excludes it is the write itself: `date_modified` moves to now, which is past
 * the fix cutoff, so the row can never be selected again. That makes the
 * re-check before each write load-bearing rather than defensive.
 *
 * **That guarantee now rests on one line of SQL.** The write is raw, and raw
 * SQL bypasses Prisma's `@updatedAt` — the column has no
 * `ON UPDATE CURRENT_TIMESTAMP` behind it, as `SHOW COLUMNS` confirms. So the
 * statement assigns `date_modified` by hand, to a stamp the script chooses and
 * records in the manifest first, and refuses to build a statement whose stamp
 * is not past the fix cutoff. Drop that assignment and nothing breaks visibly:
 * the repair still writes, and every future run re-selects and re-repairs the
 * same rows, adding an hour each time.
 *
 * **Recovering from a run that stopped part-way** is a re-run with a new
 * `--manifest`: rows it wrote carry the stamp and cannot be selected again,
 * and rows it never reached still can. Undoing one is the manifest's
 * `rollback` instructions.
 *
 * Usage:
 *   npx ts-node scripts/repair-dst-schedule-times.ts            # report only
 *   npx ts-node scripts/repair-dst-schedule-times.ts --apply    # write
 *   npx ts-node scripts/repair-dst-schedule-times.ts --apply --max 300
 *   npx ts-node scripts/repair-dst-schedule-times.ts --apply --manifest run.json
 *
 * `--manifest <path>` names the rollback record. It defaults to a timestamped
 * file in the working directory, and the script refuses to overwrite one that
 * already exists — a previous run's manifest is the only way back from it.
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  SCHEDULE_FIX_DEPLOYED_AT,
  findDstWrittenScheduleRows,
  isProvablyDstWritten,
  type DstScheduleRow,
  type ScheduleTimeAuditRow,
} from "../src/server/db/dstScheduleIntegrity";
import {
  isOnCoopAt,
  isWallClockSchedule,
} from "../src/server/db/scheduleTimeIntegrity";
import { formatScheduleTime } from "../src/utils/scheduleTime";
import { createParseArgs } from "./lib/parseArgs";

/**
 * Above the 221 rows production held when this was measured on 2026-11-17 (see
 * the module docstring), with room for the set to have grown a little, and far
 * below a count that could only mean the selection rule has broken. Higher than the wall-clock repair's 50 because
 * the population is genuinely larger, not because the guard matters less.
 */
const DEFAULT_MAX = 300;

export type { Options } from "./lib/parseArgs";

/** The columns the rule and the report need. */
const AUDIT_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  startTime: true,
  endTime: true,
  startDate: true,
  endDate: true,
  dateCreated: true,
  dateModified: true,
  // The offset evidence. Both relations are required in `schema.prisma`, but
  // `relationMode = "prisma"` emulates the foreign key, so a dangling id is a
  // shape the database still permits and Prisma hands back `null` for it.
  // `toAuditRow` normalises that rather than trusting the generated type.
  companyLocation: { select: { coordLat: true, coordLng: true } },
  homeLocation: { select: { coordLat: true, coordLng: true } },
} as const;

/**
 * What `findMany` with {@link AUDIT_SELECT} returns for one row: the audit
 * shape with the two locations still nested under their relation names.
 */
type SelectedRow = Omit<
  ScheduleTimeAuditRow,
  "companyCoords" | "homeCoords"
> & {
  companyLocation: { coordLat: number; coordLng: number } | null;
  homeLocation: { coordLat: number; coordLng: number } | null;
};

/**
 * The selected row in the shape the pure rule reads.
 *
 * Flattens the two relations onto the field names
 * `isEasternOffsetEvidenced` expects, so the rule stays free of Prisma's
 * include shape and testable with plain objects.
 */
export const toAuditRow = (row: SelectedRow): ScheduleTimeAuditRow => ({
  ...row,
  companyCoords: row.companyLocation ?? null,
  homeCoords: row.homeLocation ?? null,
});

/**
 * The number the dry run has to state before anyone types `--apply`: how many
 * rows would have both schedule columns overwritten.
 *
 * Kept separate from the printing so it can be tested without a database.
 */
export const summariseRepair = (
  candidates: readonly DstScheduleRow[],
): { rowCount: number } => ({ rowCount: candidates.length });

/**
 * Order candidates so two runs against unchanged data print the same lines in
 * the same order. `findMany` without an `orderBy` has no guaranteed order, so
 * without this a re-run looks like a different plan.
 */
export const sortById = (
  candidates: readonly DstScheduleRow[],
): DstScheduleRow[] =>
  [...candidates].sort((a, b) => a.row.id.localeCompare(b.row.id));

export type RepairDecision =
  { action: "repair" } | { action: "skip"; reason: string };

/**
 * Whether two stored `TIME(0)` values hold the same digits.
 *
 * Compared as the digits `repairStatement` binds rather than as instants, so
 * this refuses exactly what the statement's `WHERE` would.
 */
const sameStoredTime = (a: Date | null, b: Date | null): boolean =>
  a !== null && b !== null && toSqlTime(a) === toSqlTime(b);

/**
 * The re-check that runs against a row read *after* the plan was built, once
 * per row, immediately before its own write.
 *
 * The case that matters is a user who opened their profile and retyped their
 * schedule in between. Their row is already canonical, and `dateModified`
 * would now be past the fix cutoff — so re-asking `isProvablyDstWritten` is
 * what catches it, and it is the same question the plan was built from rather
 * than a second, weaker one. The co-op and wall-clock checks are re-run for
 * the same reason: anything that would have excluded the row at planning time
 * must still exclude it now.
 *
 * **`planned` is the row as the plan read it**, and the repaired value was
 * computed from it. So the current row must still *be* that row — same
 * `date_modified`, same two values — not merely still pass the rule. A write
 * that changed a value without advancing `date_modified` (raw SQL, which
 * bypasses `@updatedAt`) would otherwise pass every check above and be
 * overwritten by a value computed from what it replaced. `repairStatement`
 * enforces the same snapshot in its `WHERE`; this is the early, explained
 * refusal, and that is the one that cannot be raced.
 */
export const decideRepair = (
  current: ScheduleTimeAuditRow | null,
  planned: Pick<ScheduleTimeAuditRow, "startTime" | "endTime" | "dateModified">,
  asOf: Date,
): RepairDecision => {
  if (!current) {
    return { action: "skip", reason: "the row no longer exists" };
  }

  if (!current.startTime || !current.endTime) {
    return { action: "skip", reason: "the schedule has since been cleared" };
  }

  if (!isProvablyDstWritten(current)) {
    return {
      action: "skip",
      reason: "the row has been saved since the plan was built",
    };
  }

  if (current.dateModified.getTime() !== planned.dateModified.getTime()) {
    return {
      action: "skip",
      reason: "date_modified has moved since the plan was built",
    };
  }

  if (
    !sameStoredTime(current.startTime, planned.startTime) ||
    !sameStoredTime(current.endTime, planned.endTime)
  ) {
    return {
      action: "skip",
      reason:
        "the schedule values changed since the plan was built without " +
        "date_modified moving",
    };
  }

  if (isWallClockSchedule(current.startTime, current.endTime)) {
    return {
      action: "skip",
      reason: "the schedule now reads as a wall-clock value",
    };
  }

  if (!isOnCoopAt(current, asOf)) {
    return { action: "skip", reason: "the co-op is no longer running" };
  }

  return { action: "repair" };
};

/**
 * A stored `@db.Time(0)` as MySQL's `TIME` literal.
 *
 * Read with UTC accessors because that is how the column comes back — Prisma
 * epoch-dates it and the digits live in the UTC fields. `getHours()` would
 * return whatever the runner's zone made of that instant, which is how a
 * repair writes different values on a laptop than on a CI box.
 *
 * A string rather than the `Date` itself: bound as a parameter, a `Date`
 * reaches a `TIME` column as a datetime and MySQL is left to take the time
 * part of it. The digits are what this is about, so they are sent as digits.
 */
export const toSqlTime = (time: Date): string =>
  [time.getUTCHours(), time.getUTCMinutes(), time.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

/**
 * A `datetime(3)` as MySQL's literal, to millisecond precision.
 *
 * The precision is the point: `date_modified` is `datetime(3)` and this value
 * is the compare-and-swap key. Truncating to the second would make the
 * comparison match a row that had been written within the same second.
 */
export const toSqlDateTime = (at: Date): string => {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");

  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}.` +
    `${pad(at.getUTCMilliseconds(), 3)}`
  );
};

/**
 * The repair as a single compare-and-swap.
 *
 * **Raw SQL rather than `prisma.carpoolSearch.update`, and not for speed.**
 * The re-check in `decideRepair` reads the row and then the write happens; a
 * profile save landing between the two would be overwritten by a value
 * computed from the stale read. Putting `date_modified` in the `WHERE` moves
 * the decision into the statement, where it is evaluated against the current
 * committed row.
 *
 * **It has to be raw.** `updateMany` is not a compare-and-swap in this repo:
 * under `relationMode = "prisma"` the engine selects the matching ids and then
 * updates by id, so a concurrent caller still reports `count: 1`. `user.edit`
 * and `groups.ts` reach for the same raw primitive for the same reason, and
 * both say so at length.
 *
 * **The swap is on the plan's whole snapshot, not on `date_modified`
 * alone.** The repaired value is computed from the plan's two stored values,
 * so the statement must only land on a row that still holds them. Keying on
 * `date_modified` would be enough *if* every write advanced it, and every
 * application write that changes a schedule does today — `user.edit` goes
 * through `carpoolSearch.update`, so `@updatedAt` moves it. But nothing in
 * the database enforces that: the column has no `ON UPDATE`, four of the
 * raw `UPDATE carpool_search` statements in `groups.ts` and `admin.ts`
 * already leave it alone, and a console session would too. So the prior
 * values are in the `WHERE` as well.
 *
 * **`date_modified` is assigned explicitly** because raw SQL bypasses
 * `@updatedAt` and the column carries no `ON UPDATE CURRENT_TIMESTAMP`. That
 * assignment is the whole of the rerun guarantee — see the module docstring.
 * It is a value the caller chose and recorded in the manifest *before* sending
 * this, rather than `NOW(3)`, so a run that dies before it can record an
 * outcome still leaves the rollback an exact predicate for "this run wrote
 * this row and nobody has touched it since". A stamp at or before the fix
 * cutoff would leave the row selectable, so it is refused here, where no
 * caller can skip the check.
 *
 * Returned rather than executed so the test can read `.sql` and `.values`
 * directly. A behavioural test cannot see a missing `SET date_modified`; the
 * run would still look correct and quietly stop being idempotent.
 */
export const repairStatement = (
  planned: Pick<
    ScheduleTimeAuditRow,
    "id" | "startTime" | "endTime" | "dateModified"
  >,
  repair: { startTime: Date; endTime: Date },
  stampedAt: Date,
): Prisma.Sql => {
  if (stampedAt.getTime() <= SCHEDULE_FIX_DEPLOYED_AT.getTime()) {
    throw new Error(
      `refusing to stamp date_modified at ${stampedAt.toISOString()}: it ` +
        `must be after ${SCHEDULE_FIX_DEPLOYED_AT.toISOString()} or the row ` +
        `stays selectable and a re-run repairs it twice. Check this ` +
        `machine's clock.`,
    );
  }

  if (!planned.startTime || !planned.endTime) {
    throw new Error(`search ${planned.id} has no schedule to repair`);
  }

  return Prisma.sql`
    UPDATE carpool_search
    SET start_time = ${toSqlTime(repair.startTime)},
        end_time = ${toSqlTime(repair.endTime)},
        date_modified = ${toSqlDateTime(stampedAt)}
    WHERE id = ${planned.id}
      AND date_modified = ${toSqlDateTime(planned.dateModified)}
      AND start_time = ${toSqlTime(planned.startTime)}
      AND end_time = ${toSqlTime(planned.endTime)}
  `;
};

/**
 * How one row ended up, as the manifest records it.
 *
 * `in-flight` is written *before* a row's statement is sent and replaced once
 * it returns, so a row left at `in-flight` is one the run may or may not have
 * written — the run died in between. `failed` is the same uncertainty with an
 * error to show for it: a connection lost after the commit fails the call too.
 * Neither is resolved by guessing; the rollback's `date_modified` predicate
 * says which of them actually landed.
 */
export type ManifestOutcome =
  | "pending"
  | "dry-run"
  | "in-flight"
  | "repaired"
  | "skipped"
  | "lost-race"
  | "failed";

export type ManifestRow = {
  searchId: string;
  userId: string;
  dateCreated: string;
  /** The `date_modified` the compare-and-swap is keyed on. */
  dateModifiedAtPlan: string;
  priorStartTime: string;
  priorEndTime: string;
  proposedStartTime: string;
  proposedEndTime: string;
  /**
   * The `date_modified` this run writes onto the row, recorded before the
   * statement is sent. Absent until the run reaches the row.
   */
  repairStampedAt?: string;
  outcome: ManifestOutcome;
  note?: string;
};

export type Manifest = {
  script: "repair-dst-schedule-times";
  /** 2 added `repairStampedAt` and the `in-flight` outcome. */
  manifestVersion: 2;
  generatedAt: string;
  asOf: string;
  mode: "dry-run" | "apply";
  candidateCount: number;
  /** How to undo a run, kept with the data rather than in a wiki page. */
  rollback: string;
  rows: ManifestRow[];
};

/**
 * How to reverse a run, written into the file rather than left to be
 * remembered. `date_modified` is deliberately *not* restored: putting it back
 * would make the row selectable again, so a rollback would be undone by the
 * next run of this script.
 *
 * **Keyed on the stamp, not on the recorded outcome.** A run that died between
 * a write and the flush that would have recorded it leaves that row at
 * `in-flight` or `failed`, so "rows marked repaired" misses exactly the rows a
 * crash makes uncertain. And the two value predicates alone are not enough:
 * an owner who retyped their schedule after the repair stores the same
 * canonical value the repair did, and a value-only rollback would put the
 * broken one back over what they typed. The stamp is the run's own
 * fingerprint, so it matches only rows this run wrote and nobody has saved
 * since.
 */
const ROLLBACK_INSTRUCTIONS =
  "To undo: for each row with outcome 'repaired', 'in-flight' or 'failed', " +
  "run UPDATE carpool_search SET start_time = <priorStartTime>, " +
  "end_time = <priorEndTime> WHERE id = <searchId> AND " +
  "start_time = <proposedStartTime> AND end_time = <proposedEndTime> AND " +
  "date_modified = <repairStampedAt> (as 'YYYY-MM-DD HH:MM:SS.mmm' UTC). " +
  "A row whose write never landed, or whose owner has saved since, does " +
  "not match and is left alone - so 'in-flight' and 'failed' rows are safe " +
  "to include whatever actually happened to them. Do NOT restore " +
  "date_modified: leaving it at the repair's value is what keeps the row " +
  "out of a later run. To finish a run that stopped part-way instead, " +
  "re-run the script with a new --manifest: the rows it wrote are no " +
  "longer selectable and the rest still are.";

/**
 * The rollback record for a planned run.
 *
 * Built from the plan rather than written as each row succeeds, so the file
 * describes every row the run intends to touch *before* it touches any of
 * them. A crash after the third write still leaves the prior values of all
 * 221 rows on disk.
 */
export const buildManifest = (
  candidates: readonly DstScheduleRow[],
  meta: { asOf: Date; mode: "dry-run" | "apply"; now: Date },
): Manifest => ({
  script: "repair-dst-schedule-times",
  manifestVersion: 2,
  generatedAt: meta.now.toISOString(),
  asOf: meta.asOf.toISOString(),
  mode: meta.mode,
  candidateCount: candidates.length,
  rollback: ROLLBACK_INSTRUCTIONS,
  rows: candidates.map(({ row, repairStartTime, repairEndTime }) => ({
    searchId: row.id,
    userId: row.userId,
    dateCreated: row.dateCreated.toISOString(),
    dateModifiedAtPlan: row.dateModified.toISOString(),
    priorStartTime: toSqlTime(row.startTime as Date),
    priorEndTime: toSqlTime(row.endTime as Date),
    proposedStartTime: toSqlTime(repairStartTime),
    proposedEndTime: toSqlTime(repairEndTime),
    outcome: meta.mode === "apply" ? "pending" : "dry-run",
  })),
});

/** Records one row's outcome in place. Returns whether the row was found. */
export const recordOutcome = (
  manifest: Manifest,
  searchId: string,
  outcome: ManifestOutcome,
  note?: string,
  repairStampedAt?: Date,
): boolean => {
  const entry = manifest.rows.find((row) => row.searchId === searchId);
  if (!entry) {
    return false;
  }

  entry.outcome = outcome;
  if (note !== undefined) {
    entry.note = note;
  }
  if (repairStampedAt !== undefined) {
    entry.repairStampedAt = repairStampedAt.toISOString();
  }

  return true;
};

/**
 * The default manifest path: timestamped, so two runs never collide.
 *
 * Colons are stripped because they are not portable in filenames.
 */
export const defaultManifestPath = (now: Date): string =>
  `dst-schedule-repair-${now.toISOString().replace(/[:.]/g, "-")}.json`;

/** The mode a new manifest is created at: it holds a user id per row. */
const MANIFEST_MODE = 0o600;

const serialiseManifest = (manifest: Manifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

/**
 * Writes `contents` to a new, uniquely named file beside `target`, at exactly
 * `mode`, flushed to disk. Returns its path. On any failure the partial file
 * is removed and the error rethrown; `target` is never opened.
 *
 * Beside the target rather than in a temp directory because `rename` is only
 * atomic within one filesystem. `fchmod` after `open` because the `open` mode
 * is filtered through the process umask, and a umask is not something an
 * operator's shell can be trusted to have set sensibly.
 */
const writeDurableSibling = (
  target: string,
  contents: string,
  mode: number,
): string => {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );

  let fd: number | undefined;
  try {
    // `wx`: a name collision is refused rather than written through.
    fd = openSync(temp, "wx", mode);
    fchmodSync(fd, mode);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    return temp;
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already failing; the original error is the one worth reporting.
      }
    }
    rmSync(temp, { force: true });
    throw error;
  }
};

/**
 * Makes a rename or link inside `dir` durable. Without it the new name can be
 * lost on power failure even though the file's contents were fsynced.
 *
 * Skipped on Windows, which cannot open a directory for fsync.
 */
const fsyncDirectory = (dir: string): void => {
  if (process.platform === "win32") {
    return;
  }

  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

/**
 * Creates the manifest at mode `0600`, atomically.
 *
 * **Refuses an existing path**, which would be the rollback record of
 * whichever run produced it. The contents go to a fsynced sibling first and
 * are then hard-linked into place: `link` fails if the name is taken, so the
 * refusal and the creation are one step with no window between them, and the
 * name never points at a partially written file.
 *
 * It holds a user id per row, which is why it is `0600` and why it belongs
 * somewhere deliberate rather than in a shared temp directory.
 */
export const writeManifest = (path: string, manifest: Manifest): void => {
  const temp = writeDurableSibling(
    path,
    serialiseManifest(manifest),
    MANIFEST_MODE,
  );

  try {
    linkSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }

  fsyncDirectory(dirname(path));
};

/**
 * Replaces a manifest this run already created, as outcomes resolve.
 *
 * **Atomic, so the last valid record survives anything.** Truncating the file
 * and writing it again — what a plain `writeFileSync` does — leaves an empty or
 * half-written file if the process dies, the disk fills, or the write throws
 * part-way, and at that moment the only record of which rows were rewritten is
 * gone. Here the new contents are written and fsynced to a sibling and then
 * renamed over the old file, so at every instant the path holds either the
 * previous complete manifest or the new complete one. A failure before the
 * rename removes the sibling and leaves the previous record exactly as it was.
 *
 * **Preserves the existing file's permission bits** rather than resetting
 * them: if an operator has tightened the record mid-run, a flush does not
 * loosen it again. A manifest that has gone missing is an error rather than
 * something to recreate — the run's record has been moved by somebody, and
 * carrying on writing rows without knowing where it went is the wrong answer.
 */
export const replaceManifest = (path: string, manifest: Manifest): void => {
  const contents = serialiseManifest(manifest);
  const mode = statSync(path).mode & 0o777;
  const temp = writeDurableSibling(path, contents, mode);

  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }

  fsyncDirectory(dirname(path));
};

/**
 * The reads and the write `applyRepairs` needs, so the loop can be driven by a
 * test without a database. `main` supplies the Prisma-backed one.
 */
export type RepairStore = {
  readRow: (searchId: string) => Promise<ScheduleTimeAuditRow | null>;
  execute: (statement: Prisma.Sql) => Promise<number>;
};

export type ApplyResult = {
  repaired: number;
  skipped: number;
  lostRace: number;
};

/**
 * The write half of a run: one candidate at a time, re-read, re-checked,
 * recorded, written, recorded again.
 *
 * The order of those steps is the crash-safety argument, so it is fixed here
 * rather than left to `main`:
 *
 *   1. Re-read and `decideRepair`. A skip is recorded and flushed.
 *   2. Choose the stamp, record the row as `in-flight` with it, and flush —
 *      **before** the statement is sent. If the flush fails, nothing has been
 *      written and the run stops.
 *   3. Send the compare-and-swap.
 *   4. Record `repaired`, `lost-race` or `failed`, and flush.
 *
 * A crash between any two of those leaves a manifest on disk that is complete
 * and true: `pending` rows were never sent, and every row that might have been
 * written carries the stamp its rollback matches on.
 *
 * A failed statement or a failed flush stops the run rather than moving on.
 * Either means something is wrong with the connection or the disk, and the
 * next row would hit the same thing.
 */
export const applyRepairs = async ({
  store,
  candidates,
  manifest,
  manifestFile,
  asOf,
  clock = () => new Date(),
  log = console.log,
}: {
  store: RepairStore;
  candidates: readonly DstScheduleRow[];
  manifest: Manifest;
  manifestFile: string;
  asOf: Date;
  clock?: () => Date;
  log?: (line: string) => void;
}): Promise<ApplyResult> => {
  const result: ApplyResult = { repaired: 0, skipped: 0, lostRace: 0 };

  for (const candidate of candidates) {
    const searchId = candidate.row.id;

    // Re-read. Between building the plan and getting here the user may have
    // retyped their schedule, and overwriting that would be worse than the
    // bug.
    const current = await store.readRow(searchId);

    const decision = decideRepair(current, candidate.row, asOf);
    if (decision.action === "skip") {
      log(`  search ${searchId}: skipped — ${decision.reason}`);
      recordOutcome(manifest, searchId, "skipped", decision.reason);
      replaceManifest(manifestFile, manifest);
      result.skipped++;
      continue;
    }

    // Built before anything is recorded, so a stamp `repairStatement` refuses
    // stops the run with the row still at `pending`.
    const stampedAt = clock();
    const statement = repairStatement(
      candidate.row,
      {
        startTime: candidate.repairStartTime,
        endTime: candidate.repairEndTime,
      },
      stampedAt,
    );

    // Write-ahead: the stamp is on disk before the statement that writes it
    // is sent.
    recordOutcome(manifest, searchId, "in-flight", undefined, stampedAt);
    replaceManifest(manifestFile, manifest);

    log(
      `  search ${searchId}: ` +
        `${iso(candidate.row.startTime)}-${iso(candidate.row.endTime)} → ` +
        `${iso(candidate.repairStartTime)}-${iso(candidate.repairEndTime)}`,
    );

    // Both columns in one statement, so an interrupted run never leaves a row
    // with a repaired start and an unrepaired end — which would be a schedule
    // nobody entered and no reading explains.
    let affected: number;
    try {
      affected = await store.execute(statement);
    } catch (error) {
      // Recorded and flushed before rethrowing, so the manifest describes the
      // row the run died on. Not "not written": a connection lost after the
      // commit fails this call too, which is why the stamp stays recorded.
      recordOutcome(
        manifest,
        searchId,
        "failed",
        `outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
      );
      replaceManifest(manifestFile, manifest);
      throw error;
    }

    if (affected === 0) {
      // The row moved between the re-read and this statement. Rare, and
      // exactly the case the compare-and-swap exists for.
      log(
        `  search ${searchId}: skipped — the row was saved while this ` +
          `statement was being prepared`,
      );
      recordOutcome(manifest, searchId, "lost-race");
      replaceManifest(manifestFile, manifest);
      result.lostRace++;
      continue;
    }

    recordOutcome(manifest, searchId, "repaired");
    replaceManifest(manifestFile, manifest);
    result.repaired++;
  }

  return result;
};

/**
 * Pulls `--manifest <path>` out of the argument list.
 *
 * Handled here rather than in `createParseArgs` because that parser is shared
 * by seven scripts and only this one writes a manifest. The remaining
 * arguments go through the shared parser unchanged, so every guarantee its
 * tests pin — `--apply` required to write, unknown arguments throwing — still
 * holds for the arguments it sees.
 */
export const extractManifestPath = (
  argv: readonly string[],
): { manifestPath: string | null; rest: string[] } => {
  const rest: string[] = [];
  let manifestPath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--manifest") {
      rest.push(argv[i]);
      continue;
    }

    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--manifest expects a path");
    }
    manifestPath = value;
  }

  return { manifestPath, rest };
};

/**
 * Exported so the test can pin the property that matters most: writing
 * requires `--apply`, and there is no argument spelling that reaches a write
 * by accident.
 */
export const parseArgs = createParseArgs(DEFAULT_MAX);

/**
 * What a run that exceeds `--max` prints before refusing.
 *
 * **No row count of its own.** It used to quote the size of the population
 * when the script was written, and that number was wrong by the time it
 * shipped — 210 where production held 221 — and would only have drifted
 * further: the pool can only shrink as people edit their profiles. A stale
 * figure in a refusal is worse than none, because it is the number an
 * operator compares against when deciding whether to raise `--max`. The
 * measured count, with its date, lives in the module docstring.
 */
export const maxRefusalMessage = (rowCount: number, max: number): string =>
  `✖ ${rowCount} candidate(s) exceeds --max ${max}. Refusing to run, and ` +
  `not listing them. The default ceiling sits just above the count measured ` +
  `when this script was reviewed, so a count above it means the data or the ` +
  `selection rule has changed. Find out which before re-running with a ` +
  `higher --max.`;

/** The stored digits, read in UTC because that is how the column is stored. */
const iso = (time: Date | null): string =>
  time
    ? `${String(time.getUTCHours()).padStart(2, "0")}:` +
      `${String(time.getUTCMinutes()).padStart(2, "0")}`
    : "null";

/** One candidate as a line an operator can read and, if needed, undo from. */
const describeCandidate = (candidate: DstScheduleRow): string => {
  const { row, repairStartTime, repairEndTime } = candidate;

  return (
    `    search ${row.id}  (${row.userId}  ${row.role}  ${row.status})\n` +
    `      start_time ${iso(row.startTime)} → ${iso(repairStartTime)}` +
    `   displays ${formatScheduleTime(row.startTime)} → ` +
    `${formatScheduleTime(repairStartTime)}\n` +
    `      end_time   ${iso(row.endTime)} → ${iso(repairEndTime)}` +
    `   displays ${formatScheduleTime(row.endTime)} → ` +
    `${formatScheduleTime(repairEndTime)}`
  );
};

const main = async () => {
  const { manifestPath, rest } = extractManifestPath(process.argv.slice(2));
  const { apply, max } = parseArgs(rest);
  const prisma = new PrismaClient();

  const startedAt = new Date();
  const manifestFile = manifestPath ?? defaultManifestPath(startedAt);

  // Checked before the database is touched: discovering the manifest path is
  // taken after 200 rows have been rewritten helps nobody.
  if (existsSync(manifestFile)) {
    console.error(
      `\u2716 ${manifestFile} already exists. It may be a previous run's ` +
        `rollback record, which is the only way back from that run. Pass ` +
        `--manifest <path> with a name that is not yet taken.`,
    );
    process.exitCode = 2;
    await prisma.$disconnect();
    return;
  }

  // One clock for the whole run, so the plan and every re-check agree about
  // which co-ops are running even if the run straddles midnight.
  const asOf = new Date();

  try {
    const selected = await prisma.carpoolSearch.findMany({
      select: AUDIT_SELECT,
    });
    const rows = selected.map(toAuditRow);

    const candidates = sortById(findDstWrittenScheduleRows(rows, asOf));
    const { rowCount } = summariseRepair(candidates);

    const onCoop = rows.filter((row) => isOnCoopAt(row, asOf)).length;

    // Printed so the dry run states the size of the population it is *not*
    // touching as well as the one it is. The gap between these two numbers is
    // the ambiguous remainder, and it should not take a separate query to see
    // that this script leaves it alone.
    const onCoopWithSchedule = rows.filter(
      (row) => isOnCoopAt(row, asOf) && row.startTime && row.endTime,
    ).length;

    // The span-provable population before the offset evidence is applied, so
    // the run states how many rows it dropped for want of Eastern-time
    // evidence rather than leaving that gap to be noticed.
    const spanProvable = rows.filter(
      (row) =>
        row.startTime !== null &&
        row.endTime !== null &&
        isOnCoopAt(row, asOf) &&
        isProvablyDstWritten(row) &&
        !isWallClockSchedule(row.startTime, row.endTime),
    ).length;

    console.log(`${rows.length} carpool search row(s)`);
    console.log(`${onCoop} with a co-op running today`);
    console.log(`${onCoopWithSchedule} of those carrying a schedule`);
    console.log(`${spanProvable} of those provably written during EDT`);
    console.log(
      `${rowCount} of those also evidencing an Eastern-time author ` +
        `(${spanProvable - rowCount} dropped for want of that evidence)`,
    );

    if (rowCount === 0) {
      console.log("\n✓ nothing to repair.");
      return;
    }

    // The ceiling is checked *before* the candidates are printed. Each line
    // carries a user id, and dumping hundreds of them to a terminal is not
    // something to do on the way to refusing the run anyway.
    if (rowCount > max) {
      console.error(`\n${maxRefusalMessage(rowCount, max)}`);
      process.exitCode = 2;
      return;
    }

    // Listed in full rather than sampled. Each entry is one person's working
    // day being rewritten, and these lines are the only rollback record there
    // is — the ceiling above already bounds how many there can be.
    console.log("");
    for (const candidate of candidates) {
      console.log(describeCandidate(candidate));
    }

    // Written before anything else happens, in both modes. In a dry run it is
    // the plan somebody reviews; under --apply it is the rollback record, and
    // it has to exist before the first write rather than after the last one.
    const manifest = buildManifest(candidates, {
      asOf,
      mode: apply ? "apply" : "dry-run",
      now: startedAt,
    });
    writeManifest(manifestFile, manifest);
    console.log(`\nManifest written to ${manifestFile} (mode 0600)`);

    if (!apply) {
      console.log(
        `\nDry run — nothing written. Would rewrite start_time and end_time ` +
          `on ${rowCount} row(s). Re-run with --apply to write.`,
      );
      return;
    }

    const { repaired, skipped, lostRace } = await applyRepairs({
      store: {
        readRow: async (searchId) => {
          const current = await prisma.carpoolSearch.findUnique({
            where: { id: searchId },
            select: AUDIT_SELECT,
          });
          return current ? toAuditRow(current) : null;
        },
        execute: (statement) => prisma.$executeRaw(statement),
      },
      candidates,
      manifest,
      manifestFile,
      asOf,
    });

    console.log(`\n✓ repaired ${repaired} schedule(s)`);
    if (skipped > 0) {
      console.log(
        `  ${skipped} row(s) had changed by the time they were reached and ` +
          `were left alone`,
      );
    }
    if (lostRace > 0) {
      console.log(
        `  ${lostRace} row(s) were saved mid-statement and were left alone`,
      );
    }
    console.log(`  rollback record: ${manifestFile}`);
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import the pure halves without opening a database
// connection or writing anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
