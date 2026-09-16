/**
 * Repair the three data defects earlier bugs left behind: seat counts
 * outside `[0, MAX_SEATS_AVAILABLE]`, `CarpoolGroup` rows with no members, and
 * `CarpoolGroup` rows whose members include no `DRIVER`.
 *
 * All three code paths were fixed and no fix was retroactive. `reserveSeat` is
 * an atomic compare-and-swap now, so no new negative can be written,
 * `groups.edit` verifies membership, so no new group can be leaked, and
 * `groups.create` requires the named driver to actually hold `Role.DRIVER`
 * (SCRUM-291), so no new group can be born driverless — but the rows already
 * written stayed, one of them an ACTIVE driver at `-1`.
 *
 * `repair-` rather than `backfill-` or `cleanup-`: it writes a column *and*
 * deletes a row, so neither existing verb describes it, and the parts are one
 * defect's residue rather than separate chores. The first two are together
 * because they share an origin — the overwritten-membership bug cost a driver a
 * seat and abandoned their old group in the same event — so finding one is a
 * reason to look for the other. The third joins them because it is the same
 * classifier (`findGroupAnomalies`) and the same destructive verb on the same
 * table, and splitting it out would duplicate every safety rail below.
 *
 * Safety, because this writes to and deletes from production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Every candidate is re-checked immediately before its write, against rows
 *     read after the plan was built. A driver who re-saved their profile in
 *     between keeps the value they entered, a group somebody joined in
 *     between is not deleted, and a group that gained a `DRIVER` in between is
 *     no longer driverless and is left alone.
 *   - Refuses to proceed when any candidate count exceeds `--max`
 *     (default 500).
 *   - One group at a time, and each dissolve is a single transaction, so a
 *     partial run leaves a consistent database.
 *   - Prints the prior value of every row it touches before touching it. That
 *     is the rollback record: restoring a `-1` is not something anyone would
 *     want, but "what was it before" should not be unanswerable. For a dissolve
 *     that record is the member ids, since `carpoolId` is what gets cleared.
 *
 * The seat repair writes `0`, not a guess at the driver's original capacity.
 * The capacity is not stored separately — `seatsAvail` means "capacity" before
 * a group exists and "remaining" after — so it cannot be recovered, and
 * inventing one upwards would over-subscribe a real car. `0` is truthful and
 * the driver can raise it by re-saving their profile. Consider telling them.
 *
 * The driverless repair **dissolves** — it clears `carpoolId` for every member
 * and deletes the group row. It does not promote anyone to `DRIVER`, and that
 * is a decision rather than an omission (SCRUM-406). The server did not enforce
 * `Role.DRIVER` on `groups.create` until SCRUM-291, and the client named
 * whichever party did not accept the request as the group's driver without
 * checking their role — so a group could be *born* driverless. There is
 * therefore no "original driver" to restore: promoting a member would invent a
 * driver who never existed, and would put someone in charge of a car they may
 * not own. Dissolving presumes nothing about the group's history, which is why
 * it is correct whichever way a given group got here.
 *
 * A dissolve deliberately touches **only** `carpoolId` and the group row.
 * Seats are not credited back: there is no driver to credit, and the members'
 * own `seatsAvail` is not a debt this repair created. Roles, profiles, users
 * and the searches themselves are left exactly as they are.
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

export type GroupMemberRow = { userId: string; role: Role };

/**
 * What the report has to state before anyone types `--apply`: how many group
 * rows would be deleted, and how many `carpoolId` values would be cleared.
 *
 * Kept separate from the printing so the arithmetic can be tested without a
 * database. The membership count is the sum over groups rather than the number
 * of groups, because those are the two different numbers an operator is being
 * asked to authorise and conflating them is how a repair gets approved for the
 * wrong blast radius.
 */
export const summariseDissolution = (
  groups: readonly { id: string; members: readonly GroupMemberRow[] }[],
): { groupCount: number; membershipCount: number } => ({
  groupCount: groups.length,
  membershipCount: groups.reduce((total, g) => total + g.members.length, 0),
});

/**
 * Order candidates so two runs against unchanged data print the same lines in
 * the same order. `findMany` without an `orderBy` has no guaranteed order, so
 * without this a re-run looks like a different plan.
 */
export const sortById = <T extends { id: string }>(groups: readonly T[]): T[] =>
  [...groups].sort((a, b) => a.id.localeCompare(b.id));

export type DissolutionDecision =
  { action: "dissolve" } | { action: "skip"; reason: string };

/**
 * The re-check that runs against rows read *after* the plan was built, one
 * group before its own write.
 *
 * A group that has gained a `DRIVER` in the meantime is no longer the defect
 * this repairs — somebody either joined it or changed role into it — so it is
 * left alone rather than dissolved out from under them. A group that has lost
 * every member is still deleted: that is the `empty` defect, and the row is
 * leaked either way.
 */
export const decideDissolution = (
  members: readonly { role: Role }[],
): DissolutionDecision =>
  members.some((member) => member.role === Role.DRIVER)
    ? { action: "skip", reason: "a DRIVER joined since the plan was built" }
    : { action: "dissolve" };

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
    const anomalies = findGroupAnomalies(
      groups.map((group) => ({
        id: group.id,
        members: byGroup.get(group.id) ?? [],
      })),
    );
    const empty = sortById(anomalies.empty);
    const driverless = sortById(anomalies.driverless);
    const { groupCount, membershipCount } = summariseDissolution(driverless);

    console.log(`${searches.length} carpool search row(s)`);
    console.log(`${outOfRange.length} with an out-of-range seat count`);
    console.log(`${groups.length} carpool group row(s)`);
    console.log(`${empty.length} with no members at all`);
    console.log(
      `${groupCount} with members but no DRIVER, holding ` +
        `${membershipCount} membership(s)`,
    );

    if (
      outOfRange.length === 0 &&
      empty.length === 0 &&
      driverless.length === 0
    ) {
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

    // Every driverless group is listed rather than sampled like the two above.
    // Each line is a separate group about to be destroyed and a separate set of
    // people returned to matching, and `--max` already bounds how many there
    // can be. A truncated list is the wrong thing to approve a dissolve from.
    for (const group of driverless) {
      const roles = group.members
        .map((member) => member.role)
        .sort()
        .join(", ");
      console.log(
        `\n    group    ${group.id}  (${group.members.length} member(s): ` +
          `${roles}) → clear carpoolId, delete group`,
      );
    }

    if (
      outOfRange.length > max ||
      empty.length > max ||
      driverless.length > max
    ) {
      console.error(
        `\n✖ ${outOfRange.length} seat candidate(s), ${empty.length} empty ` +
          `group candidate(s) and ${driverless.length} driverless group ` +
          `candidate(s); one exceeds --max ${max}. Refusing to run. Confirm ` +
          `this is expected, then re-run with a higher --max.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log(
        `\nDry run — nothing written. Would delete ${empty.length} empty and ` +
          `${groupCount} driverless group row(s), clearing ${membershipCount} ` +
          `carpoolId value(s). Re-run with --apply to write.`,
      );
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

    let dissolved = 0;
    let membershipsCleared = 0;
    let dissolvesSkipped = 0;

    for (const group of driverless) {
      // Re-read the membership as it is now, not as it was when planned.
      const members = await prisma.carpoolSearch.findMany({
        where: { carpoolId: group.id },
        select: { userId: true, role: true },
      });

      const decision = decideDissolution(members);
      if (decision.action === "skip") {
        console.log(`  group  ${group.id}: skipped — ${decision.reason}`);
        dissolvesSkipped++;
        continue;
      }

      // The rollback record: these are the rows whose `carpoolId` pointed here.
      console.log(
        `  group  ${group.id}: clearing carpoolId for ${members.length} ` +
          `member(s) [${members.map((m) => m.userId).join(", ")}], ` +
          `then deleting the group`,
      );

      // One transaction per group. `relationMode = "prisma"` emulates the
      // foreign key, so the clear is what detaches the members — ordering it
      // before the delete keeps the two from being observable apart, and means
      // an interrupted run never leaves a `carpoolId` pointing at a row that is
      // already gone. Only `carpoolId` is written: no seat, role or status.
      const [cleared] = await prisma.$transaction([
        prisma.carpoolSearch.updateMany({
          where: { carpoolId: group.id },
          data: { carpoolId: null },
        }),
        prisma.carpoolGroup.delete({ where: { id: group.id } }),
      ]);

      membershipsCleared += cleared.count;
      dissolved++;
    }

    console.log(
      `\n✓ repaired ${seatsRepaired} seat count(s), deleted ` +
        `${groupsDeleted} empty group row(s), dissolved ${dissolved} ` +
        `driverless group(s) and cleared ${membershipsCleared} carpoolId ` +
        `value(s)`,
    );
    if (dissolvesSkipped > 0) {
      console.log(
        `  ${dissolvesSkipped} driverless group(s) had gained a DRIVER by the ` +
          `time they were reached and were left alone`,
      );
    }
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
