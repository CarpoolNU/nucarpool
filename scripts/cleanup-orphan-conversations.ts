/**
 * Delete `Conversation` rows that no live `Request` reaches by either link, and
 * the `Message` rows inside them.
 *
 * The schema's cascade points the wrong way: `Request` holds the foreign key,
 * so `onDelete: Cascade` runs Conversation -> Request. Nothing ran the other
 * direction, so every decline and withdrawal used to leave a conversation and
 * its messages behind. `requests.delete` now removes both in one transaction,
 * which makes this a one-off for the backlog -- a second run should report zero.
 *
 * **The production backlog is retained by decision, not pending deletion.** 620
 * conversations and 1,258 messages are kept, revisited only if they cause a
 * problem. This script's job today is to *report*: it is the instrument that
 * would show the population growing, which would mean that fix had regressed.
 * **Do not run `--apply` against production without a new explicit decision.**
 *
 * **Unreachability needs both links dead, and that was measured.** The
 * relationship is stored twice: `getConversationMessages` reads
 * `Conversation.requestId`, while `requests.me` and the unread count read
 * `Request.conversationId`. `findOrphanConversationIds` tests both, which is
 * the same definition the pre-delete re-check uses, so the plan and the action
 * cannot disagree. On production, read-only: all 620 fail both links and none
 * is still referenced either way. Staging holds 11 conversations, 25 messages,
 * so staging is no guide to the scale.
 *
 * Safety, because this deletes real message content:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - **Every candidate is re-checked immediately before its delete**, by
 *     *both* links, against rows read after the plan was built. This matters
 *     beyond staleness: `Request.conversation` declares `onDelete: Cascade`,
 *     so deleting a conversation a live request points at would take that
 *     request with it.
 *   - **Refuses past `--max`** (default 500), so a logic error that classified
 *     every conversation as an orphan stops here.
 *   - **Prints every conversation and its message count before deleting it.**
 *     That is the only rollback record there can be: restoring private
 *     messages is impossible, but "which rows went" must be answerable.
 *   - One conversation at a time, each in its own transaction, so a partial
 *     run leaves a consistent database. Counters are reported even if a
 *     candidate throws.
 *
 * **Use `--limit`, not `--max`, for a population above the ceiling.** The
 * backlog is 620 against a default of 500, so a bare `--apply` exits 2.
 * `--limit 400` acts on the oldest 400 and defers the rest; raising `--max`
 * restores exactly the single command the ceiling exists to prevent.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-orphan-conversations.ts             # report only
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --apply     # delete
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --apply --limit 400
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --older-than 2025-01-01
 *
 * `--older-than` is a UTC date, compared strictly. **Confirm `DATABASE_URL`
 * before using `--apply`; this script does not print it.**
 */

import { PrismaClient } from "@prisma/client";
import { findOrphanConversationIds } from "../src/server/db/conversationLink";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 20;

export type Options = {
  apply: boolean;
  max: number;
  /** Act on at most this many candidates, oldest first. */
  limit?: number;
  /** Consider only conversations created strictly before this UTC instant. */
  olderThan?: Date;
};

const CUTOFF_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parsed as a UTC midnight rather than a local one, so the tranche a given
 * cutoff selects does not depend on the operator's timezone or on whether
 * daylight saving was in force — the documented failure mode for the
 * schedule columns.
 */
const parseCutoff = (value: string | undefined): Date => {
  const match = CUTOFF_PATTERN.exec(value ?? "");
  if (!match) {
    throw new Error(
      `--older-than expects a YYYY-MM-DD date, got ${value ?? ""}`,
    );
  }

  const [, year, month, day] = match;
  const cutoff = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );

  // `Date.UTC` rolls 2026-02-31 forward into March rather than rejecting it,
  // so the components are compared back to catch a date that does not exist.
  // A silently shifted cutoff would select a different tranche than the
  // operator asked for.
  if (
    cutoff.getUTCFullYear() !== Number(year) ||
    cutoff.getUTCMonth() !== Number(month) - 1 ||
    cutoff.getUTCDate() !== Number(day)
  ) {
    throw new Error(`--older-than expects a real calendar date, got ${value}`);
  }

  return cutoff;
};

/**
 * Exported so `cleanup-orphan-conversations.test.ts` can pin the property that
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
    } else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit expects a positive integer, got ${argv[i]}`);
      }
      options.limit = value;
    } else if (arg === "--older-than") {
      options.olderThan = parseCutoff(argv[++i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
};

export type Candidate = {
  id: string;
  requestId: string;
  dateCreated: Date;
  messages: number;
};

/**
 * Splits the plan into what this run will act on and what it defers.
 *
 * Pure and exported for the same reason as `parseArgs`: this is the arithmetic
 * that decides which private messages a run destroys, and it should be provable
 * without a database.
 *
 * Oldest first, so a `--limit` tranche is deterministic across runs and retires
 * the longest-standing rows rather than an arbitrary slice. `id` breaks ties,
 * because `dateCreated` is not unique and a total order is what makes
 * "the oldest 400" mean the same thing twice.
 */
export const selectCandidates = (
  candidates: readonly Candidate[],
  { limit, olderThan }: Pick<Options, "limit" | "olderThan">,
): { selected: Candidate[]; deferred: Candidate[] } => {
  const oldestFirst = [...candidates].sort(
    (a, b) =>
      a.dateCreated.getTime() - b.dateCreated.getTime() ||
      a.id.localeCompare(b.id),
  );

  const selected: Candidate[] = [];
  const deferred: Candidate[] = [];

  for (const candidate of oldestFirst) {
    const withinCutoff =
      olderThan === undefined || candidate.dateCreated < olderThan;
    const withinLimit = limit === undefined || selected.length < limit;

    if (withinCutoff && withinLimit) {
      selected.push(candidate);
    } else {
      deferred.push(candidate);
    }
  }

  return { selected, deferred };
};

const describeCandidate = (candidate: Candidate): string =>
  `${candidate.id}  ${candidate.messages} message(s)  ` +
  `request ${candidate.requestId} (gone)  ` +
  `created ${candidate.dateCreated.toISOString().slice(0, 10)}`;

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const main = async () => {
  const { apply, max, limit, olderThan } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const [conversations, requests] = await Promise.all([
      prisma.conversation.findMany({
        select: { id: true, requestId: true, dateCreated: true },
      }),
      // `conversationId` as well as `id`, because the orphan predicate tests
      // both links. Reading only the ids would make the plan disagree with the
      // pre-delete re-check, which is the gap that closed.
      prisma.request.findMany({ select: { id: true, conversationId: true } }),
    ]);

    const orphanIds = findOrphanConversationIds(conversations, requests);

    // Counted per orphan rather than in total, because the per-row number is
    // what tells the operator whether a candidate held a real exchange or was
    // an empty shell.
    const messageCounts = new Map<string, number>();
    if (orphanIds.length > 0) {
      const grouped = await prisma.message.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: orphanIds } },
        _count: { _all: true },
      });
      for (const row of grouped) {
        messageCounts.set(row.conversationId, row._count._all);
      }
    }

    const byId = new Map(conversations.map((row) => [row.id, row]));
    const candidates: Candidate[] = orphanIds.flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [
            {
              id,
              requestId: row.requestId,
              dateCreated: row.dateCreated,
              messages: messageCounts.get(id) ?? 0,
            },
          ]
        : [];
    });

    const totalMessages = candidates.reduce(
      (sum, candidate) => sum + candidate.messages,
      0,
    );

    console.log(`${conversations.length} conversation row(s)`);
    console.log(`${requests.length} request row(s)`);
    console.log(`${candidates.length} conversation(s) no request reaches`);
    console.log(`${totalMessages} message(s) inside them`);

    if (candidates.length === 0) {
      console.log("\n✓ every conversation is reachable from a request.");
      return;
    }

    const { selected, deferred } = selectCandidates(candidates, {
      limit,
      olderThan,
    });

    for (const candidate of selected.slice(0, SAMPLE_SIZE)) {
      console.log(`    ${describeCandidate(candidate)}`);
    }
    if (selected.length > SAMPLE_SIZE) {
      console.log(`    ... and ${selected.length - SAMPLE_SIZE} more selected`);
    }

    if (deferred.length > 0) {
      const selectedMessages = selected.reduce(
        (sum, candidate) => sum + candidate.messages,
        0,
      );
      console.log(
        `\n${selected.length} of ${candidates.length} candidate(s) selected ` +
          `(${selectedMessages} message(s)); ${deferred.length} deferred to a ` +
          `later run.`,
      );
    }

    if (selected.length === 0) {
      console.log(
        "\nNothing selected — every candidate was filtered out. Widen " +
          "--older-than or raise --limit.",
      );
      return;
    }

    // The ceiling applies to what this run would act on, which is what makes
    // `--limit 400` a route through a 620-row backlog without raising it. The
    // full candidate total is printed above and unaffected, so a predicate
    // error that flagged the whole table is still visible in the report — but
    // note that a `--limit` small enough would then delete that many
    // *reachable* rows, and only the per-candidate log below would show it.
    if (selected.length > max) {
      console.error(
        `\n✖ ${selected.length} selected exceeds --max ${max}. Refusing to ` +
          `run. Retire this population in tranches with --limit ${max} rather ` +
          `than raising --max.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log(
        `\nDry run — nothing deleted. Re-run with --apply to delete ` +
          `${selected.length} conversation(s) and their message(s). ` +
          `That is irreversible.`,
      );
      return;
    }

    let deleted = 0;
    let deletedMessages = 0;
    let rescued = 0;
    const failures: string[] = [];

    try {
      for (const candidate of selected) {
        // Re-check against current rows, by both links. Between building the
        // plan and getting here a request could have been pointed at this row —
        // `findOrCreateConversation` keys on `requestId`, and a reopen writes
        // `Request.conversationId` — so either reference rescues it.
        const referencing = await prisma.request.count({
          where: {
            OR: [{ conversationId: candidate.id }, { id: candidate.requestId }],
          },
        });

        if (referencing > 0) {
          console.log(`    ${candidate.id}  rescued, a request reaches it`);
          rescued++;
          continue;
        }

        // Printed before the delete, not after: this line is the only record
        // that this row existed once the transaction commits.
        console.log(`    ${describeCandidate(candidate)}  → deleting`);

        try {
          // One transaction per candidate, matching `requests.delete`. The
          // messages are removed explicitly rather than left to Prisma's
          // emulated cascade, so the count reported below is what was actually
          // deleted rather than an assumption about what Prisma did.
          const removed = await prisma.$transaction(async (tx) => {
            const messages = await tx.message.deleteMany({
              where: { conversationId: candidate.id },
            });
            await tx.conversation.delete({ where: { id: candidate.id } });

            return messages.count;
          });

          // Incremented only once the transaction has committed. Counting
          // inside the callback would credit a row that a commit failure
          // rolled back.
          deletedMessages += removed;
          deleted++;
        } catch (error) {
          // Recorded and carried past, rather than aborting the run: one
          // candidate failing is not a reason to lose the record of the ones
          // that succeeded, and the transaction means this row is untouched,
          // so it is still an orphan and a later run picks it up again.
          failures.push(`${candidate.id}: ${reason(error)}`);
          console.error(`    ${candidate.id}  ✖ failed: ${reason(error)}`);
        }
      }
    } finally {
      // In a `finally` so an unexpected throw — the re-check query failing
      // mid-run, say — still reports what had already been removed. Without
      // this the audit trail for a partial run of an irreversible operation
      // would be whatever happened to be on screen.
      console.log(
        `\n✓ deleted ${deleted} conversation(s) and ${deletedMessages} message(s)`,
      );
      if (rescued > 0) {
        console.log(
          `  ${rescued} conversation(s) were referenced by a request by the ` +
            `time they were reached and were left alone`,
        );
      }
      if (deferred.length > 0) {
        console.log(
          `  ${deferred.length} candidate(s) deferred, not attempted`,
        );
      }
      if (failures.length > 0) {
        console.error(`  ${failures.length} failed and were left in place:`);
        for (const failure of failures) {
          console.error(`    ${failure}`);
        }
        process.exitCode = 1;
      }
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
