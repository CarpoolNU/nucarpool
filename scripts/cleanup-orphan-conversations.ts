/**
 * Delete `Conversation` rows that no live `Request` reaches by either link, and
 * the `Message` rows inside them.
 *
 * The cascade in the schema points the wrong way for this: `Request` holds the
 * foreign key, so `onDelete: Cascade` runs Conversation → Request. Nothing ran
 * Request → Conversation, so every decline, withdrawal and "Leave
 * Conversation" left a conversation and its messages behind. `requests.delete`
 * now removes both in one transaction, which makes this a one-off
 * for the backlog rather than a recurring chore — running it a second time
 * should report zero.
 *
 * **The production backlog is retained by decision, not pending deletion.**
 * SCRUM-365 decided to keep the 620 conversations and their 1,258 messages and
 * to revisit only if they cause a problem. So this script's job today is to
 * *report* — it is the instrument that would show the population growing, which
 * would be the sign that that change's fix had regressed. Nothing here should be
 * run with `--apply` against production without a new, explicit decision that
 * supersedes.
 *
 * **These rows are unreachable, and that was measured rather than assumed.**
 * The relationship is stored twice, so there are two ways a request can still
 * reach a conversation, and unreachability needs both to be dead:
 * `getConversationMessages` goes through `Conversation.requestId`, while
 * `requests.me` and the unread count go through `Request.conversationId`.
 * `findOrphanConversationIds` now tests both, which is the same definition the
 * pre-delete re-check below uses — so the plan and the action can no longer
 * disagree. Both links were answered on production, read-only, on 2026-09-03:
 * **zero** orphans were still pointed at by a live request, and all **620**
 * fail both. What counts them regardless is `admin.getDashboardStats`, which is
 * why the dashboard's conversation figure and its messages-per-conversation
 * average read high while the 620 are retained.
 *
 * **This deletes real message content, and production is much larger than
 * staging.** Measured read-only on 2026-09-03:
 *
 *   - production: **620 conversations, all of them non-empty, 1,258 messages**
 *     in total, the largest holding 28
 *   - production, both links: **620** unreachable through
 *     `Conversation.requestId` *and* `Request.conversationId`; **0** still
 *     referenced either way
 *   - staging: 11 conversations, 25 messages
 *
 * So `--apply` against production would destroy over twelve hundred messages
 * that two people typed to each other and nobody can read any more. The dry run
 * prints the message count per conversation for exactly that reason.
 *
 * **Retiring a population larger than `--max` is what `--limit` is for.** The
 * default ceiling is 500 and the backlog is 620, so a bare `--apply` refuses
 * with exit code 2. The route through that is `--limit 400`, which acts on the
 * oldest 400 and reports the rest as deferred — *not* `--max 700`, which
 * restores exactly the single command the ceiling exists to prevent: "a
 * population this size should not be deleted by a command that looks identical
 * to the one that would have deleted eleven rows."
 *
 * Safety, because this deletes production rows:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - Every candidate is re-checked immediately before its delete, against
 *     rows read after the plan was built, by *both* links — a request that
 *     appeared pointing at it either way rescues it. This matters beyond
 *     staleness: `Request.conversation` declares `onDelete: Cascade`, so
 *     deleting a conversation a live request points at would take that request
 *     with it.
 *   - Refuses when the number of candidates it would *act on* exceeds `--max`
 *     (default 500). A logic error that classified every conversation as an
 *     orphan stops here rather than emptying the messaging history.
 *   - Prints every conversation, with its message count, immediately before
 *     deleting it. That is the rollback record: restoring private messages is
 *     not something anyone can do, but "which rows went" must not be
 *     unanswerable.
 *   - Reports its counters on the way out even if a candidate throws, and
 *     carries on past a single failure rather than discarding the record of
 *     what already succeeded.
 *   - Deletes one conversation at a time, each pair of statements in its own
 *     transaction. Slower than deleteMany, and deliberately so: a partial run
 *     leaves a consistent database.
 *
 * `relationMode = "prisma"` means MySQL holds no foreign key from
 * `conversation` to `request`, so "orphan" has to be computed here rather than
 * asked of the database. The `Message` rows go through Prisma's emulated
 * cascade, which is why they are deleted by the client rather than by MySQL.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-orphan-conversations.ts             # report only
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --apply     # delete
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --apply --limit 400
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --older-than 2025-01-01
 *
 * `--older-than` is a UTC date, and the comparison is strict: a conversation
 * created exactly at that midnight is not older than it.
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
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
 * daylight saving was in force — the failure mode SCRUM-373 documents for the
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
      // pre-delete re-check, which is the gap SCRUM-364 closed.
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
