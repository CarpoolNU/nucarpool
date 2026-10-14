/**
 * Delete `CarpoolPairing` rows past the retention window.
 *
 * The retention position decided on SCRUM-636 is twelve months from `endedAt`,
 * and expiry is a **deletion** rather than an anonymisation: a pairing row
 * stripped of its user ids is useless to everything that reads it. This script
 * is the half of that decision which makes it true — a reader that merely
 * filters old rows out hides them, and the commitment was that they are gone.
 *
 * **Nothing in this repository runs on a schedule.** This is a hand-run chore
 * until something does, which is what SCRUM-675 tracks. It is safe to leave
 * un-run for a while and it is safe to run twice: the window is twelve months
 * and the record only began accumulating when this shipped, so for the first
 * year there is nothing for it to find, and `scripts/README.md` describes how
 * to tell whether it still has work to do.
 *
 * Safety, because this deletes production rows:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default
 *     500). A clock skewed a year forward, or a cutoff computed wrongly, would
 *     select the whole table — that stops here rather than emptying it.
 *   - Prints counts and dates only, never a user id. These rows are a record
 *     of who travelled with whom, which is the most identifying thing the
 *     schema holds; an operator checking whether the sweep has work to do does
 *     not need to see who is in it.
 *
 * One `deleteMany` rather than a row at a time, unlike
 * `cleanup-orphan-locations.ts`. That script re-checks each candidate because
 * a concurrent write can rescue one; nothing rescues a pairing. `endedAt` is
 * never updated, so a row that is outside the window stays outside it, and the
 * predicate cannot select a row the plan did not count.
 *
 * Usage:
 *   npx ts-node scripts/expire-carpool-pairings.ts              # report only
 *   npx ts-node scripts/expire-carpool-pairings.ts --apply      # delete
 *   npx ts-node scripts/expire-carpool-pairings.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import {
  PAIRING_RETENTION_MONTHS,
  pairingRetentionCutoff,
} from "../src/server/db/carpoolPairing";

const DEFAULT_MAX = 500;

export type Options = { apply: boolean; max: number };

/**
 * Exported so `expire-carpool-pairings.test.ts` can pin the property that
 * matters most: deleting requires `--apply`, and there is no argument spelling
 * that reaches a delete by accident.
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
  const cutoff = pairingRetentionCutoff(new Date());

  try {
    const total = await prisma.carpoolPairing.count();
    const expired = await prisma.carpoolPairing.count({
      where: { endedAt: { lt: cutoff } },
    });

    console.log(`retention: ${PAIRING_RETENTION_MONTHS} months from endedAt`);
    console.log(`cutoff:    ${cutoff.toISOString()}`);
    console.log(`${total} pairing row(s)`);
    console.log(`${expired} past the retention window`);

    if (expired === 0) {
      console.log("\n✓ nothing to expire.");
      return;
    }

    // The date range rather than the rows: enough for an operator to see that
    // the candidates are the age they expect, without naming anybody.
    const oldest = await prisma.carpoolPairing.findFirst({
      where: { endedAt: { lt: cutoff } },
      orderBy: { endedAt: "asc" },
      select: { endedAt: true },
    });
    const newest = await prisma.carpoolPairing.findFirst({
      where: { endedAt: { lt: cutoff } },
      orderBy: { endedAt: "desc" },
      select: { endedAt: true },
    });
    console.log(
      `    ended between ${oldest?.endedAt.toISOString()} and ` +
        `${newest?.endedAt.toISOString()}`,
    );

    if (expired > max) {
      console.error(
        `\n✖ ${expired} candidates exceeds --max ${max}. Refusing to run. ` +
          `Confirm this is expected, then re-run with a higher --max.`,
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

    const { count } = await prisma.carpoolPairing.deleteMany({
      where: { endedAt: { lt: cutoff } },
    });

    console.log(`\n✓ deleted ${count} row(s)`);
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
