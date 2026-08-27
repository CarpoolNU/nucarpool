/**
 * Report `CarpoolGroup` rows that have no DRIVER member (SCRUM-289).
 *
 * A group's driver is the member whose `CarpoolSearch.role` is `DRIVER`. Every
 * management path depends on one existing: `requireGroupDriver` throws
 * FORBIDDEN for every member of a group without one, so nobody can remove
 * anybody and nobody can dissolve it, and `groups.me` resolves preferences
 * through the driver's own search, so the riders' shared notes read as blank.
 *
 * Two guards now prevent new ones - `user.edit` refuses a role change away from
 * DRIVER while the caller is in a group, and `groups.edit` refuses to let a
 * driver leave a group of three or more. Neither is retroactive, and the
 * client-side-only guard that preceded them was deleted in December 2024, so
 * this reports what the intervening period may have left behind.
 *
 * **Read-only. This script changes nothing.**
 *
 * Deliberately so, following `check-self-requests.ts` rather than
 * `cleanup-orphan-locations.ts`: there is no single correct repair. A group of
 * three whose driver became a rider might want that member promoted back to
 * DRIVER, or might want dissolving - and only the people in it know which. A
 * script cannot choose, so this one reports and stops.
 *
 * Three shapes are reported separately because they are not the same problem.
 * The file is named for the first, which it originally only reported; the third
 * arrived with SCRUM-291, whose overwritten-membership bug is what creates it:
 *
 *   - **Driverless with members.** The SCRUM-289 failure. The members are
 *     listed so someone can contact them; repair is either promoting one
 *     member's `CarpoolSearch.role` back to `DRIVER` or clearing `carpoolId`
 *     for all of them and deleting the group row.
 *   - **Empty.** A group row no `CarpoolSearch` points at. Nobody is affected
 *     and nothing reads it; it is a leaked row, safe to delete once confirmed.
 *   - **Driver only.** A group holding its driver and nobody else, left behind
 *     when a rider's membership was overwritten by a join elsewhere - the
 *     dissolve-at-one-member rule runs in the mutation that removed someone,
 *     and that was a different group. Safe to dissolve, but the same event also
 *     cost that driver a seat, which this script cannot see (SCRUM-291).
 *
 * Usage:
 *   npx ts-node scripts/check-driverless-groups.ts
 *
 * Exits 0 when every group has a driver, 1 when any does not, so it can gate a
 * follow-up.
 */

import { PrismaClient, Role } from "@prisma/client";

export type GroupMember = {
  userId: string;
  role: Role;
};

export type GroupWithMembers = {
  id: string;
  members: readonly GroupMember[];
};

export type GroupAnomalies = {
  /** Has members, none of them a DRIVER - the SCRUM-289 failure. */
  driverless: GroupWithMembers[];
  /** No members at all - a leaked row, not a stranded carpool. */
  empty: GroupWithMembers[];
  /** A lone DRIVER - the group an overwritten membership left behind. */
  solo: GroupWithMembers[];
};

/**
 * Splits groups into the three problem shapes, leaving healthy groups out.
 *
 * The categories are mutually exclusive, in this order: no members at all, then
 * members but no driver, then a single member who *is* the driver. A group
 * holding one lone rider is therefore reported as driverless rather than solo,
 * which is the more useful of the two labels for it - it is stuck, not merely
 * orphaned.
 *
 * A group with more than one DRIVER is *not* reported. `create` now refuses to
 * build one, every management path still works if one exists, and folding it in
 * would bury the groups that are actually broken.
 */
export const findGroupAnomalies = (
  groups: readonly GroupWithMembers[],
): GroupAnomalies => {
  const driverless: GroupWithMembers[] = [];
  const empty: GroupWithMembers[] = [];
  const solo: GroupWithMembers[] = [];

  for (const group of groups) {
    if (group.members.length === 0) {
      empty.push(group);
      continue;
    }

    if (!group.members.some((member) => member.role === Role.DRIVER)) {
      driverless.push(group);
      continue;
    }

    // A carpool of one is not a carpool. `edit` dissolves at one remaining
    // member, but only inside the mutation that removed someone - so a rider
    // whose membership was overwritten by a join elsewhere left their old
    // group behind holding just its driver, with nothing to clean it up and
    // the driver's seat never returned (SCRUM-291).
    if (group.members.length === 1) {
      solo.push(group);
    }
  }

  return { driverless, empty, solo };
};

const main = async () => {
  if (process.argv.length > 2) {
    throw new Error(
      `unexpected argument(s): ${process.argv.slice(2).join(", ")}. ` +
        `This script takes none and only reads.`,
    );
  }

  const prisma = new PrismaClient();

  try {
    // One read per table rather than a nested include: `relationMode =
    // "prisma"` resolves an include as a second query anyway, and the group
    // table is small enough that reading it whole is cheaper than N+1.
    const [groups, memberships] = await Promise.all([
      prisma.carpoolGroup.findMany({ select: { id: true } }),
      prisma.carpoolSearch.findMany({
        where: { carpoolId: { not: null } },
        select: { userId: true, role: true, carpoolId: true },
      }),
    ]);

    const byGroup = new Map<string, GroupMember[]>(
      groups.map((group) => [group.id, []]),
    );

    for (const membership of memberships) {
      // A membership pointing at a group row that is gone is its own problem
      // and `groups.me` already guards against it; it is not this report's.
      byGroup
        .get(membership.carpoolId as string)
        ?.push({ userId: membership.userId, role: membership.role });
    }

    const { driverless, empty, solo } = findGroupAnomalies(
      groups.map((group) => ({
        id: group.id,
        members: byGroup.get(group.id) ?? [],
      })),
    );

    console.log(`${groups.length} carpool group row(s)`);
    console.log(`${driverless.length} with members but no driver`);
    console.log(`${empty.length} with no members at all`);
    console.log(`${solo.length} holding only their driver`);

    if (driverless.length === 0 && empty.length === 0 && solo.length === 0) {
      console.log("\n✓ every carpool group has a driver and a passenger.");
      return;
    }

    for (const group of driverless) {
      console.log(`\n    group    ${group.id}  (no driver, stranded)`);
      for (const member of group.members) {
        console.log(`      member ${member.userId}  ${member.role}`);
      }
    }

    for (const group of empty) {
      console.log(`\n    group    ${group.id}  (no members, leaked row)`);
    }

    for (const group of solo) {
      console.log(`\n    group    ${group.id}  (driver only, orphaned)`);
      for (const member of group.members) {
        console.log(`      member ${member.userId}  ${member.role}`);
      }
    }

    if (driverless.length > 0) {
      console.log(
        `\n✖ Each stranded group needs a decision from the people in it: ` +
          `promote one member's CarpoolSearch.role back to DRIVER, or clear ` +
          `carpoolId for every member and delete the group row. Do not pick ` +
          `for them.`,
      );
    }

    if (empty.length > 0) {
      console.log(
        `\n✖ The empty rows affect nobody and can be deleted once confirmed ` +
          `still empty.`,
      );
    }

    if (solo.length > 0) {
      console.log(
        `\n✖ Each driver-only group is one a departed rider left behind. ` +
          `Dissolving it is safe - clear carpoolId for the driver and delete ` +
          `the group row - but check first whether that driver is also short ` +
          `a seat, which the same event caused and this script cannot tell.`,
      );
    }

    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import findDriverlessGroups without opening a
// database connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
