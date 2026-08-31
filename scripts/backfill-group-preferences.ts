/**
 * Backfill the group preference columns from the legacy blob (SCRUM-253).
 *
 * `carpool_search.group_notes`, `group_music_preference` and
 * `group_conversation_style` replace a `GROUP_DETAILS_V1:` JSON string that was
 * written into `carpool_search.group_message` and mirrored into `group.message`.
 * New saves write the columns directly; this moves the history across.
 *
 * Why a script rather than a data migration: `prisma/migrations/` is never
 * applied to PlanetScale. The schema reaches an environment through
 * `prisma db push` and a Deploy Request, and neither runs an `UPDATE`, so a data
 * migration would be dead text in the repository. Run this once per environment
 * after the columns exist. Same reasoning as
 * `scripts/backfill-request-status.ts`.
 *
 * Reading is safe before this runs -- `resolveGroupDetails` falls back to the
 * legacy column while all three are null -- so there is no window where a
 * driver's preferences look lost. This exists so the fallback can eventually be
 * deleted along with `group_message`.
 *
 * What gets written: `parseGroupDetails` output, which covers the encoded form,
 * a plain-text message from before the encoding existed (kept as notes, per the
 * ticket), and a corrupt blob (also kept as notes rather than discarded).
 *
 * Safety, because this writes to production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Only ever fills rows where all three columns are null, so it cannot
 *     overwrite a preference a driver has since saved. Re-running is a no-op.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default 500).
 *   - Updates one row at a time by primary key, so a partial run leaves a
 *     consistent database.
 *   - Never touches `group_message` or `group.message`. Dropping those is a
 *     separate, later step.
 *
 * Usage:
 *   npx ts-node scripts/backfill-group-preferences.ts              # report only
 *   npx ts-node scripts/backfill-group-preferences.ts --apply      # write
 *   npx ts-node scripts/backfill-group-preferences.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import {
  GroupDetails,
  hasAnyDetail,
  parseGroupDetails,
} from "../src/components/Group/groupDetails";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 10;

export type Options = { apply: boolean; max: number };

/**
 * Exported so the test can pin the property that matters most: writing requires
 * `--apply`, and no argument spelling reaches a write by accident.
 */
export const parseArgs = (argv: string[]): Options => {
  const options: Options = { apply: false, max: DEFAULT_MAX };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--max") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--max needs a positive integer, got: ${argv[i]}`);
      }
      options.max = value;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }

  return options;
};

export type LegacyRow = { id: string; groupMessage: string | null };

export type Candidate = {
  id: string;
  details: GroupDetails;
};

/**
 * The rows worth writing, and what to write.
 *
 * A row whose legacy message decodes to nothing is skipped rather than written
 * as three empty strings. Writing it would mark it migrated for no benefit, and
 * leaving it null keeps the (identical) fallback result.
 *
 * Exported and pure so the decision can be tested without a database.
 */
export const findCandidates = (rows: readonly LegacyRow[]): Candidate[] =>
  rows.reduce<Candidate[]>((candidates, row) => {
    const details = parseGroupDetails(row.groupMessage);

    if (hasAnyDetail(details)) {
      candidates.push({ id: row.id, details });
    }

    return candidates;
  }, []);

const main = async () => {
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    // Only un-migrated rows: all three columns null. A row a driver has saved
    // since the deploy is already authoritative and must not be reverted to
    // whatever the old blob said.
    const rows = await prisma.carpoolSearch.findMany({
      where: {
        groupNotes: null,
        groupMusicPreference: null,
        groupConversationStyle: null,
        NOT: { groupMessage: null },
      },
      select: { id: true, groupMessage: true },
    });

    const candidates = findCandidates(rows);

    console.log(`${rows.length} un-migrated row(s) with a legacy message.`);
    console.log(`${candidates.length} carrying preferences worth writing.`);

    if (candidates.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    for (const candidate of candidates.slice(0, SAMPLE_SIZE)) {
      const { notes, musicPreference, conversationStyle } = candidate.details;
      console.log(
        `  ${candidate.id}: notes=${JSON.stringify(notes)} music=${JSON.stringify(
          musicPreference,
        )} conversation=${JSON.stringify(conversationStyle)}`,
      );
    }
    if (candidates.length > SAMPLE_SIZE) {
      console.log(`  ... and ${candidates.length - SAMPLE_SIZE} more.`);
    }

    if (candidates.length > max) {
      throw new Error(
        `${candidates.length} candidates exceeds --max ${max}. Re-run with a higher --max if that is expected.`,
      );
    }

    if (!apply) {
      console.log("\nDry run. Re-run with --apply to write these.");
      return;
    }

    let written = 0;
    for (const candidate of candidates) {
      await prisma.carpoolSearch.update({
        where: { id: candidate.id },
        data: {
          groupNotes: candidate.details.notes,
          groupMusicPreference: candidate.details.musicPreference,
          groupConversationStyle: candidate.details.conversationStyle,
        },
      });
      written++;
    }

    console.log(`${written} row(s) migrated.`);
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
