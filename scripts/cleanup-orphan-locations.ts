/**
 * Delete `Location` rows that no `CarpoolSearch` points at (SCRUM-232).
 *
 * `user.edit` used to "find or create" a Location by address text, so every
 * address change left the previous row behind and nothing ever deleted it.
 * `resolveOwnedLocations` no longer abandons rows, which makes this a one-off
 * for the backlog rather than a recurring chore — running it a second time
 * should report zero.
 *
 * Safety, because this deletes production rows:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - Every candidate is re-checked immediately before its delete, against
 *     rows read after the plan was built. A CarpoolSearch created in between
 *     therefore rescues its Location instead of losing it.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default
 *     500). A logic error that classified everything as an orphan stops here
 *     rather than emptying the table.
 *   - Deletes one row at a time by primary key. Slower than deleteMany, and
 *     deliberately so: a partial run leaves a consistent database.
 *
 * `relationMode = "prisma"` means MySQL holds no foreign key from
 * `carpool_search` to `location`, so "referenced" has to be computed here
 * rather than asked of the database.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-orphan-locations.ts              # report only
 *   npx ts-node scripts/cleanup-orphan-locations.ts --apply      # delete
 *   npx ts-node scripts/cleanup-orphan-locations.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import { findOrphanLocationIds } from "../src/server/db/locationOwnership";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 10;

export type Options = { apply: boolean; max: number };

/**
 * Exported so `cleanup-orphan-locations.test.ts` can pin the property that
 * matters most here: deleting requires `--apply`, and there is no argument
 * spelling that reaches a delete by accident.
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
    const [locations, searches] = await Promise.all([
      prisma.location.findMany({
        select: { id: true, street: true, city: true, state: true },
      }),
      prisma.carpoolSearch.findMany({
        select: { homeLocationId: true, companyLocationId: true },
      }),
    ]);

    const orphanIds = findOrphanLocationIds(
      locations.map((row) => row.id),
      searches,
    );

    console.log(`${locations.length} location row(s)`);
    console.log(`${searches.length} carpool search(es)`);
    console.log(`${orphanIds.length} unreferenced location row(s)`);

    if (orphanIds.length === 0) {
      console.log("\n✓ nothing to clean up.");
      return;
    }

    const byId = new Map(locations.map((row) => [row.id, row]));
    for (const id of orphanIds.slice(0, SAMPLE_SIZE)) {
      const row = byId.get(id);
      console.log(
        `    ${id}  ${[row?.street, row?.city, row?.state]
          .filter(Boolean)
          .join(", ")}`,
      );
    }
    if (orphanIds.length > SAMPLE_SIZE) {
      console.log(`    ... and ${orphanIds.length - SAMPLE_SIZE} more`);
    }

    if (orphanIds.length > max) {
      console.error(
        `\n✖ ${orphanIds.length} candidates exceeds --max ${max}. Refusing to ` +
          `run. Confirm this is expected, then re-run with a higher --max.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log(
        "\nDry run — nothing deleted. Re-run with --apply to delete.",
      );
      return;
    }

    let deleted = 0;
    let rescued = 0;

    for (const id of orphanIds) {
      // Re-check against current rows. Between building the plan and getting
      // here, a profile save may have pointed a CarpoolSearch at this row.
      const referencing = await prisma.carpoolSearch.count({
        where: { OR: [{ homeLocationId: id }, { companyLocationId: id }] },
      });

      if (referencing > 0) {
        rescued++;
        continue;
      }

      await prisma.location.delete({ where: { id } });
      deleted++;
    }

    console.log(`\n✓ deleted ${deleted} row(s)`);
    if (rescued > 0) {
      console.log(
        `  ${rescued} row(s) were referenced by the time they were reached ` +
          `and were left alone`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import parseArgs without opening a database
// connection or deleting anything.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
