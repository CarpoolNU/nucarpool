/**
 * Repair the schedule times that were stored as a Boston wall clock in a
 * column that holds a UTC time of day, for users whose co-op is running.
 *
 * Two of the four historical `ControlledTimePicker` implementations wrote the
 * digits the user typed straight into the column with no conversion, so a
 * 9-to-5 is stored as `09:00`-`17:00` and every surface renders it as 4:00 AM
 * to 12:00 PM. SCRUM-373 fixed the write path — `toStoredScheduleTime` pins
 * both sides to a fixed EST anchor now, so no new row can be written this way
 * — and the fix was not retroactive. `src/server/db/scheduleTimeIntegrity.ts`
 * owns which rows those are and what each should have held; this script is the
 * reads and the writes.
 *
 * **Scope, and why it is this narrow.** SCRUM-376 measured production on
 * 2026-09-21: 4,173 `carpool_search` rows, 283 with a co-op running, and eight
 * of those holding a wall clock. The repair is deliberately confined to that
 * intersection.
 *
 *   - *Only wall-clock rows.* The other defect on that ticket is a one-hour
 *     split between rows converted under EDT and rows converted under EST, and
 *     the two are not distinguishable from the stored values — `13:00`-`21:00`
 *     is equally "9-5 written in summer" and "8-4 written in winter". The best
 *     available inference is about 82% per-row, which is not a basis for an
 *     irreversible write. **Nothing here touches that population**, and a
 *     future version of this script should not start: the way to resolve those
 *     rows is to ask their owners, not to guess.
 *   - *Only running co-ops.* A student between placements re-enters their
 *     schedule when they come back, so their row corrects itself at no risk.
 *
 * Safety, because this writes to production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Every candidate is re-checked immediately before its own write, against
 *     a row read after the plan was built. Somebody who retyped their schedule
 *     in between keeps what they entered — adding five hours to an
 *     already-correct value is the one way this script could do real harm.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default 50,
 *     an order of magnitude above the eight rows measured). A run that
 *     suddenly matches hundreds means the classifier or the data has changed,
 *     and that should stop a human rather than proceed.
 *   - **Prints the prior value of every row before touching it.** That is the
 *     rollback record. Both columns are overwritten in place and there is no
 *     history table, so the transcript of a run is the only way back.
 *   - Every candidate is listed, never sampled. Each line is one person's
 *     working day being rewritten. The `--max` ceiling is checked before that
 *     listing, so a run that is going to refuse does not print hundreds of
 *     user ids on its way out.
 *   - One row per statement, both columns together, so an interrupted run
 *     never leaves a row with a repaired start and an unrepaired end.
 *
 * The repaired value is not "plus five hours" — it is whatever
 * `toStoredScheduleTime` produces for the same digits, so a repaired row is
 * byte-identical to what its owner would store by retyping their schedule into
 * the profile form today.
 *
 * Ordering: the read path needs no fix first. Unlike the seat repair, there is
 * no deployed change that masks this defect — the rows simply display wrongly
 * until they are rewritten.
 *
 * Usage:
 *   npx ts-node scripts/repair-wallclock-schedule-times.ts            # report only
 *   npx ts-node scripts/repair-wallclock-schedule-times.ts --apply    # write
 *   npx ts-node scripts/repair-wallclock-schedule-times.ts --apply --max 100
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import {
  findWallClockScheduleRows,
  isOnCoopAt,
  isWallClockSchedule,
  type ScheduleTimeRow,
  type WallClockScheduleRow,
} from "../src/server/db/scheduleTimeIntegrity";
import { formatScheduleTime } from "../src/utils/scheduleTime";

/**
 * Well above the eight rows production held when this was written, and well
 * below a count that could only mean the classifier is wrong.
 */
const DEFAULT_MAX = 50;

export type Options = { apply: boolean; max: number };

/**
 * The number the dry run has to state before anyone types `--apply`: how many
 * rows would have both schedule columns overwritten.
 *
 * Kept separate from the printing so it can be tested without a database.
 */
export const summariseRepair = (
  candidates: readonly WallClockScheduleRow[],
): { rowCount: number } => ({ rowCount: candidates.length });

/**
 * Order candidates so two runs against unchanged data print the same lines in
 * the same order. `findMany` without an `orderBy` has no guaranteed order, so
 * without this a re-run looks like a different plan.
 */
export const sortById = (
  candidates: readonly WallClockScheduleRow[],
): WallClockScheduleRow[] =>
  [...candidates].sort((a, b) => a.row.id.localeCompare(b.row.id));

export type RepairDecision =
  { action: "repair" } | { action: "skip"; reason: string };

/**
 * The re-check that runs against a row read *after* the plan was built, once
 * per row, immediately before its own write.
 *
 * The case that matters is a user who opened their profile and retyped their
 * schedule in between. Their row is already canonical, and writing the planned
 * value over it would move a correct time five hours — turning this repair
 * into the very defect it exists to undo. The co-op check is re-run for the
 * same reason: someone who changed their dates is no longer in scope.
 */
export const decideRepair = (
  current: ScheduleTimeRow | null,
  asOf: Date,
): RepairDecision => {
  if (!current) {
    return { action: "skip", reason: "the row no longer exists" };
  }

  if (!isWallClockSchedule(current.startTime, current.endTime)) {
    return {
      action: "skip",
      reason: "the schedule is no longer a wall-clock value",
    };
  }

  if (!isOnCoopAt(current, asOf)) {
    return { action: "skip", reason: "the co-op is no longer running" };
  }

  return { action: "repair" };
};

/**
 * Exported so the test can pin the property that matters most: writing
 * requires `--apply`, and there is no argument spelling that reaches a write
 * by accident.
 */
export const parseArgs = (argv: string[]): Options => {
  const options: Options = { apply: false, max: DEFAULT_MAX };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--max") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--max expects a positive integer, got ${argv[i]}`);
      }
      options.max = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
};

/** The stored digits, read in UTC because that is how the column is stored. */
const iso = (time: Date | null): string =>
  time
    ? `${String(time.getUTCHours()).padStart(2, "0")}:` +
      `${String(time.getUTCMinutes()).padStart(2, "0")}`
    : "null";

/** One candidate as a line an operator can read and, if needed, undo from. */
const describeCandidate = (candidate: WallClockScheduleRow): string => {
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
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  // One clock for the whole run, so the plan and every re-check agree about
  // which co-ops are running even if the run straddles midnight.
  const asOf = new Date();

  try {
    const rows = await prisma.carpoolSearch.findMany({
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        startTime: true,
        endTime: true,
        startDate: true,
        endDate: true,
      },
    });

    const candidates = sortById(findWallClockScheduleRows(rows, asOf));
    const { rowCount } = summariseRepair(candidates);

    const onCoop = rows.filter((row) => isOnCoopAt(row, asOf)).length;

    console.log(`${rows.length} carpool search row(s)`);
    console.log(`${onCoop} with a co-op running today`);
    console.log(`${rowCount} of those holding a wall-clock schedule`);

    if (rowCount === 0) {
      console.log("\n✓ nothing to repair.");
      return;
    }

    // The ceiling is checked *before* the candidates are printed. Each line
    // carries a user id, and dumping hundreds of them to a terminal is not
    // something to do on the way to refusing the run anyway.
    if (rowCount > max) {
      console.error(
        `\n✖ ${rowCount} candidate(s) exceeds --max ${max}. Refusing to run, ` +
          `and not listing them. Eight rows matched when this was written, so ` +
          `a count this much larger means the data or the classifier has ` +
          `changed. Confirm this is expected, then re-run with a higher --max.`,
      );
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

    if (!apply) {
      console.log(
        `\nDry run — nothing written. Would rewrite start_time and end_time ` +
          `on ${rowCount} row(s). Re-run with --apply to write.`,
      );
      return;
    }

    let repaired = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      // Re-read. Between building the plan and getting here the user may have
      // retyped their schedule, and overwriting that would be worse than the
      // bug.
      const current = await prisma.carpoolSearch.findUnique({
        where: { id: candidate.row.id },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          startTime: true,
          endTime: true,
          startDate: true,
          endDate: true,
        },
      });

      const decision = decideRepair(current, asOf);
      if (decision.action === "skip") {
        console.log(
          `  search ${candidate.row.id}: skipped — ${decision.reason}`,
        );
        skipped++;
        continue;
      }

      console.log(
        `  search ${candidate.row.id}: ` +
          `${iso(candidate.row.startTime)}-${iso(candidate.row.endTime)} → ` +
          `${iso(candidate.repairStartTime)}-${iso(candidate.repairEndTime)}`,
      );

      // Both columns in one statement, so an interrupted run never leaves a
      // row with a repaired start and an unrepaired end — which would be a
      // schedule nobody entered and no reading explains.
      await prisma.carpoolSearch.update({
        where: { id: candidate.row.id },
        data: {
          startTime: candidate.repairStartTime,
          endTime: candidate.repairEndTime,
        },
      });
      repaired++;
    }

    console.log(`\n✓ repaired ${repaired} schedule(s)`);
    if (skipped > 0) {
      console.log(
        `  ${skipped} row(s) had changed by the time they were reached and ` +
          `were left alone`,
      );
    }
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
