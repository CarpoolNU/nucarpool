/**
 * Repair the two data defects SCRUM-229 and SCRUM-291 left behind: seat counts
 * outside `[0, MAX_SEATS_AVAILABLE]`, and `CarpoolGroup` rows with no members.
 *
 * Both code paths were fixed and neither fix was retroactive. `reserveSeat` is
 * an atomic compare-and-swap now, so no new negative can be written, and
 * `groups.edit` verifies membership, so no new group can be leaked — but the
 * rows already written stayed, one of them an ACTIVE driver at `-1`.
 *
 * `repair-` rather than `backfill-` or `cleanup-`: it writes a column *and*
 * deletes a row, so neither existing verb describes it, and both halves are
 * one defect's residue rather than two chores. They are together because they
 * share an origin — the overwritten-membership bug cost a driver a seat and
 * abandoned their old group in the same event — so finding one is a reason to
 * look for the other.
 *
 * Safety, because this writes to and deletes from production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Every candidate is re-checked immediately before its write, against rows
 *     read after the plan was built. A driver who re-saved their profile in
 *     between keeps the value they entered, and a group somebody joined in
 *     between is not deleted.
 *   - Refuses to proceed when either candidate count exceeds `--max`
 *     (default 500).
 *   - One row at a time by primary key, so a partial run leaves a consistent
 *     database.
 *   - Prints the prior value of every row it touches before touching it. That
 *     is the rollback record: restoring a `-1` is not something anyone would
 *     want, but "what was it before" should not be unanswerable.
 *
 * The seat repair writes `0`, not a guess at the driver's original capacity.
 * The capacity is not stored separately — `seatsAvail` means "capacity" before
 * a group exists and "remaining" after — so it cannot be recovered, and
 * inventing one upwards would over-subscribe a real car. `0` is truthful and
 * the driver can raise it by re-saving their profile. Consider telling them.
 *
 * Ordering: **deploy the read-path fix before running this.** With
 * `hasSeatAvailable` deployed, a negative row is already excluded from
 * matching, so the user-facing dead end is closed whether or not this has run.
 * That makes the repair a data-hygiene step rather than the fix itself, which
 * is the right way round.
 *
 * Usage:
 *   npx ts-node scripts/repair-seat-residue.ts              # report only
 *   npx ts-node scripts/repair-seat-residue.ts --apply       # write
 *   npx ts-node scripts/repair-seat-residue.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient, Role } from "@prisma/client";
import { findOutOfRangeSeatRows } from "../src/server/db/seatIntegrity";
import { isSeatCountInRange } from "../src/utils/carpoolSeats";
// `findGroupAnomalies` owns what "empty" means, is already unit-tested, and its
// module is guarded by `require.main === module` so importing it here runs
// nothing. Duplicating the classification would let the two drift.
import { findGroupAnomalies } from "./check-driverless-groups";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 10;

export type Options = { apply: boolean; max: number };

/**
 * Exported so `repair-seat-residue.test.ts` can pin the property that matters
 * most here: writing requires `--apply`, and there is no argument spelling that
 * reaches a write by accident.
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

const main = async () => {
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    // One read per table rather than a nested include, following
    // check-driverless-groups.ts: `relationMode = "prisma"` resolves an
    // include as a second query anyway.
    const [searches, groups, memberships] = await Promise.all([
      prisma.carpoolSearch.findMany({
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          seatsAvail: true,
          carpoolId: true,
        },
      }),
      prisma.carpoolGroup.findMany({ select: { id: true } }),
      prisma.carpoolSearch.findMany({
        where: { carpoolId: { not: null } },
        select: { userId: true, role: true, carpoolId: true },
      }),
    ]);

    const outOfRange = findOutOfRangeSeatRows(searches);

    const byGroup = new Map<string, { userId: string; role: Role }[]>(
      groups.map((group) => [group.id, []]),
    );
    for (const membership of memberships) {
      byGroup
        .get(membership.carpoolId as string)
        ?.push({ userId: membership.userId, role: membership.role });
    }
    const { empty } = findGroupAnomalies(
      groups.map((group) => ({
        id: group.id,
        members: byGroup.get(group.id) ?? [],
      })),
    );

    console.log(`${searches.length} carpool search row(s)`);
    console.log(`${outOfRange.length} with an out-of-range seat count`);
    console.log(`${groups.length} carpool group row(s)`);
    console.log(`${empty.length} with no members at all`);

    if (outOfRange.length === 0 && empty.length === 0) {
      console.log("\n✓ nothing to repair.");
      return;
    }

    for (const { row, repairTo } of outOfRange.slice(0, SAMPLE_SIZE)) {
      console.log(
        `\n    search   ${row.id}  seats_avail ${row.seatsAvail} → ${repairTo}` +
          `  (${row.userId}  ${row.role}  ${row.status})`,
      );
    }
    if (outOfRange.length > SAMPLE_SIZE) {
      console.log(`\n    ... and ${outOfRange.length - SAMPLE_SIZE} more`);
    }

    for (const group of empty.slice(0, SAMPLE_SIZE)) {
      console.log(`\n    group    ${group.id}  (no members) → delete`);
    }
    if (empty.length > SAMPLE_SIZE) {
      console.log(`\n    ... and ${empty.length - SAMPLE_SIZE} more`);
    }

    if (outOfRange.length > max || empty.length > max) {
      console.error(
        `\n✖ ${outOfRange.length} seat candidate(s) and ${empty.length} group ` +
          `candidate(s); one exceeds --max ${max}. Refusing to run. Confirm ` +
          `this is expected, then re-run with a higher --max.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log("\nDry run — nothing written. Re-run with --apply to write.");
      return;
    }

    let seatsRepaired = 0;
    let seatsSkipped = 0;

    for (const { row, repairTo } of outOfRange) {
      // Re-read. Between building the plan and getting here the driver may
      // have re-saved their profile, which would have set a real capacity —
      // and overwriting that with 0 would be worse than the bug.
      const current = await prisma.carpoolSearch.findUnique({
        where: { id: row.id },
        select: { seatsAvail: true },
      });

      if (!current || isSeatCountInRange(current.seatsAvail)) {
        seatsSkipped++;
        continue;
      }

      console.log(
        `  search ${row.id}: ${current.seatsAvail} → ${repairTo}` +
          `  (was ${row.seatsAvail} when planned)`,
      );
      await prisma.carpoolSearch.update({
        where: { id: row.id },
        data: { seatsAvail: repairTo },
      });
      seatsRepaired++;
    }

    let groupsDeleted = 0;
    let groupsRescued = 0;

    for (const group of empty) {
      // Same re-check as cleanup-orphan-locations.ts: a join in the meantime
      // rescues the row instead of losing it.
      const members = await prisma.carpoolSearch.count({
        where: { carpoolId: group.id },
      });

      if (members > 0) {
        groupsRescued++;
        continue;
      }

      console.log(`  group  ${group.id}: deleting (no members)`);
      await prisma.carpoolGroup.delete({ where: { id: group.id } });
      groupsDeleted++;
    }

    console.log(
      `\n✓ repaired ${seatsRepaired} seat count(s), deleted ` +
        `${groupsDeleted} empty group row(s)`,
    );
    if (seatsSkipped > 0) {
      console.log(
        `  ${seatsSkipped} seat count(s) were back in range by the time they ` +
          `were reached and were left alone`,
      );
    }
    if (groupsRescued > 0) {
      console.log(
        `  ${groupsRescued} group(s) had gained a member by the time they ` +
          `were reached and were left alone`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import parseArgs without opening a database
// connection or writing anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
