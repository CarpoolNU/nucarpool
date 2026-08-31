/**
 * Backfill `Request.status` for pairs who are already carpooling (SCRUM-228).
 *
 * The new column defaults to `PENDING`, which is right for every row created
 * from now on but wrong for history: accepting a request never wrote anything,
 * so a pair who accepted months ago look identical to a pair who never answered.
 * Left alone, those rows keep the two symptoms the ticket is about — a request
 * that cannot be cleared, and a `CONFLICT` that stops the pair ever requesting
 * each other again once they leave the group.
 *
 * Why a script rather than a data migration: `prisma/migrations/` is never
 * applied to PlanetScale. The schema reaches an environment through
 * `prisma db push` and a Deploy Request, and neither runs the `UPDATE` a data
 * migration would carry, so it would be dead text in the repository. Run this
 * once per environment after the column exists.
 *
 * What counts as accepted: both users hold a `CarpoolSearch` with the same
 * non-null `carpoolId`. That is the only durable evidence acceptance left
 * behind — the group is what accepting actually produced.
 *
 * This deliberately does **not** try to resolve requests between pairs who
 * accepted and have since left the group. Nothing recorded that, so it is not
 * recoverable; those rows stay `PENDING` and the pair can clear them by
 * declining, which they could not do before.
 *
 * Safety, because this writes to production rows:
 *
 *   - **Dry run by default.** Nothing is written without `--apply`.
 *   - Only ever moves `PENDING` to `ACCEPTED`. It cannot unaccept anything, and
 *     re-running it is a no-op.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default
 *     500), so a logic error that matched everything stops here.
 *   - Updates one row at a time by primary key, so a partial run leaves a
 *     consistent database.
 *
 * `relationMode = "prisma"` means MySQL holds no foreign keys here and cannot
 * compare the two users' groups through a relation filter, so the pairing is
 * computed in memory. The table holds one row per user pair, so that is cheap.
 *
 * Usage:
 *   npx ts-node scripts/backfill-request-status.ts              # report only
 *   npx ts-node scripts/backfill-request-status.ts --apply      # write
 *   npx ts-node scripts/backfill-request-status.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient, RequestStatus } from "@prisma/client";

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

type RequestRow = {
  id: string;
  status: RequestStatus;
  fromUserId: string;
  toUserId: string;
};

/** A user's current group, or null. One entry per user with a CarpoolSearch. */
export type GroupByUser = ReadonlyMap<string, string | null>;

/**
 * The requests whose two users currently share a group, and which have not
 * already been marked accepted.
 *
 * Exported and pure so the pairing rule can be tested without a database — the
 * part worth getting wrong is "same group", not the Prisma call around it.
 */
export const findAcceptedRequestIds = (
  requests: readonly RequestRow[],
  groupByUser: GroupByUser,
): string[] =>
  requests
    .filter((request) => {
      if (request.status !== RequestStatus.PENDING) {
        return false;
      }
      const from = groupByUser.get(request.fromUserId) ?? null;
      const to = groupByUser.get(request.toUserId) ?? null;
      return from !== null && from === to;
    })
    .map((request) => request.id);

const main = async () => {
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const [requests, searches] = await Promise.all([
      prisma.request.findMany({
        select: { id: true, status: true, fromUserId: true, toUserId: true },
      }),
      prisma.carpoolSearch.findMany({
        select: { userId: true, carpoolId: true },
      }),
    ]);

    const groupByUser = new Map<string, string | null>(
      searches.map((search) => [
        search.userId,
        search.carpoolId === "" ? null : search.carpoolId,
      ]),
    );

    const candidates = findAcceptedRequestIds(requests, groupByUser);

    console.log(`${requests.length} request(s) read.`);
    console.log(
      `${candidates.length} pending request(s) between users already in the same group.`,
    );

    if (candidates.length === 0) {
      console.log("Nothing to do.");
      return;
    }

    for (const id of candidates.slice(0, SAMPLE_SIZE)) {
      console.log(`  ${id}`);
    }
    if (candidates.length > SAMPLE_SIZE) {
      console.log(`  ... and ${candidates.length - SAMPLE_SIZE} more`);
    }

    if (candidates.length > max) {
      console.error(
        `\nRefusing to write: ${candidates.length} candidates exceeds --max ${max}. ` +
          `Re-run with a higher --max if that count is genuinely expected.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log("\nDry run — nothing written. Re-run with --apply to write.");
      return;
    }

    let updated = 0;
    for (const id of candidates) {
      // `updateMany` with the status in the filter rather than `update`, so a
      // row someone resolved since the read is left alone instead of overwritten.
      const result = await prisma.request.updateMany({
        where: { id, status: RequestStatus.PENDING },
        data: { status: RequestStatus.ACCEPTED },
      });
      updated += result.count;
    }

    console.log(`\n${updated} request(s) marked ACCEPTED.`);
  } finally {
    await prisma.$disconnect();
  }
};

// Only runs as a script; importing it for the test does not touch a database.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
