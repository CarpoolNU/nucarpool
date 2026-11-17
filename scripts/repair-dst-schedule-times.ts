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
 * On production as measured on 2026-11-16 that is 210 of the 221 affected
 * live rows. The other 11 need their owners asked, not guessed at.
 *
 * Safety, because this writes to production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Every candidate is re-checked immediately before its own write, against
 *     a row read after the plan was built, so somebody who retyped their
 *     schedule in between keeps what they entered.
 *   - Refuses to proceed when the candidate count exceeds `--max`. The default
 *     is deliberately above the ~210 expected and well below a count that
 *     could only mean the rule is wrong.
 *   - **Prints the prior value of every row before touching it.** Both columns
 *     are overwritten in place and there is no history table, so the
 *     transcript of a run is the only way back.
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
 * excludes it is the write itself: `dateModified` moves to now, which is past
 * the fix cutoff, so the row can never be selected again. That makes the
 * re-check before each write load-bearing rather than defensive.
 *
 * Usage:
 *   npx ts-node scripts/repair-dst-schedule-times.ts            # report only
 *   npx ts-node scripts/repair-dst-schedule-times.ts --apply    # write
 *   npx ts-node scripts/repair-dst-schedule-times.ts --apply --max 300
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import {
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
 * Above the 210 rows production held when this was written, with room for the
 * set to have grown a little, and far below a count that could only mean the
 * selection rule has broken. Higher than the wall-clock repair's 50 because
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
} as const;

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
 */
export const decideRepair = (
  current: ScheduleTimeAuditRow | null,
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
 * Exported so the test can pin the property that matters most: writing
 * requires `--apply`, and there is no argument spelling that reaches a write
 * by accident.
 */
export const parseArgs = createParseArgs(DEFAULT_MAX);

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
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  // One clock for the whole run, so the plan and every re-check agree about
  // which co-ops are running even if the run straddles midnight.
  const asOf = new Date();

  try {
    const rows = await prisma.carpoolSearch.findMany({ select: AUDIT_SELECT });

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

    console.log(`${rows.length} carpool search row(s)`);
    console.log(`${onCoop} with a co-op running today`);
    console.log(`${onCoopWithSchedule} of those carrying a schedule`);
    console.log(`${rowCount} of those provably written under EDT`);

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
          `and not listing them. 210 rows matched when this was written, so ` +
          `a count much larger means the data or the selection rule has ` +
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
        select: AUDIT_SELECT,
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
