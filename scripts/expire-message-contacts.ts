/**
 * Delete `MessageContact` rows past the retention window.
 *
 * The sibling of `expire-carpool-pairings.ts`, for the other retained record.
 * The retention position decided on SCRUM-676 is twelve months from
 * `endedAt`, and expiry is a **deletion** rather than an anonymisation: a
 * contact row stripped of its user ids is useless to everything that reads it.
 * This script is the half of that decision which makes it true — a reader that
 * merely filters old rows out hides them, and the commitment was that they are
 * gone.
 *
 * **Why this is a second script rather than a second table swept by the
 * first.** `expire-carpool-pairings.ts` is named in `schema.prisma`, in
 * `scripts/README.md` and in SCRUM-675's recorded decision, all of which
 * describe it as the sweep for `carpool_pairing`. Widening it would change
 * what those references mean without changing what they say, and would put
 * two retention policies behind one `--max` guard whose number would then
 * mean different things for different tables. The cost is that **SCRUM-677
 * has two sweeps to schedule, not one**, which is recorded on that ticket.
 *
 * **Nothing runs this on a schedule yet.** SCRUM-675 decided expiry should be
 * a scheduled Lambda beside `infra/report-digest/`, and SCRUM-677 carries that
 * work, blocked on AWS account access; a scheduled GitHub Actions workflow was
 * rejected rather than deferred, because it would put a production
 * `DATABASE_URL` in repository secrets. Until SCRUM-677 lands this is a
 * hand-run chore, and `expire-message-contacts.test.ts` holds the obligation
 * with a tripwire that fails CI from 2027-07-01 — the same date as the pairing
 * sweep's, because both are waiting on the same unbuilt scheduler. It is safe
 * to leave un-run for a while and it is safe to run twice: the window is
 * twelve months and the record only began accumulating when this shipped, so
 * for the first year there is nothing for it to find, and `scripts/README.md`
 * describes how to tell whether it still has work to do.
 *
 * Safety, because this deletes production rows:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default
 *     500). A clock skewed a year forward, or a cutoff computed wrongly, would
 *     select the whole table — that stops here rather than emptying it.
 *   - Prints counts and dates only, never a user id. These rows are a record
 *     of who corresponded with whom, which is identifying in the same way the
 *     pairing rows are; an operator checking whether the sweep has work to do
 *     does not need to see who is in it.
 *
 * One `deleteMany` rather than a row at a time, for the reason the pairing
 * sweep gives: nothing rescues a contact row. `endedAt` is moved only by the
 * upsert in `recordContact`, and that moves it **forward**, so a row outside
 * the window can never be pulled back inside it between the count and the
 * delete — the predicate cannot select a row the plan did not count.
 *
 * Usage:
 *   npx ts-node scripts/expire-message-contacts.ts              # report only
 *   npx ts-node scripts/expire-message-contacts.ts --apply      # delete
 *   npx ts-node scripts/expire-message-contacts.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import {
  CONTACT_RETENTION_MONTHS,
  contactRetentionCutoff,
} from "../src/server/db/messageContact";

const DEFAULT_MAX = 500;

export type Options = { apply: boolean; max: number };

/**
 * Exported so `expire-message-contacts.test.ts` can pin the property that
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
  const cutoff = contactRetentionCutoff(new Date());

  try {
    const total = await prisma.messageContact.count();
    const expired = await prisma.messageContact.count({
      where: { endedAt: { lt: cutoff } },
    });

    console.log(`retention: ${CONTACT_RETENTION_MONTHS} months from endedAt`);
    console.log(`cutoff:    ${cutoff.toISOString()}`);
    console.log(`${total} contact row(s)`);
    console.log(`${expired} past the retention window`);

    if (expired === 0) {
      console.log("\n✓ nothing to expire.");
      return;
    }

    // The date range rather than the rows: enough for an operator to see that
    // the candidates are the age they expect, without naming anybody.
    const oldest = await prisma.messageContact.findFirst({
      where: { endedAt: { lt: cutoff } },
      orderBy: { endedAt: "asc" },
      select: { endedAt: true },
    });
    const newest = await prisma.messageContact.findFirst({
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

    const { count } = await prisma.messageContact.deleteMany({
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
