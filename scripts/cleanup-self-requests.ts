/**
 * Delete `Request` rows whose two ends are the same user, and the
 * `Conversation` and `Message` rows that hang off them.
 *
 * `check-self-requests.ts` finds them and stops. This is the repair half, and
 * it exists because the expected count stopped being zero: production holds
 * **2** of these, measured read-only on 2026-09-09, against 0 on
 * staging. That check's header argued against shipping a destructive tool for
 * an expected-empty set, which was the right call while the set was empty.
 *
 * **How the rows got there, and why no more can.** `requests.create` used to
 * accept `toId === ctx.session.user.id`. Its duplicate guard could not catch
 * one — for a self-request both halves of the `OR` match the same pair, so the
 * first attempt always passed — and no UI path produces one, so each row came
 * from a direct API call. The guard is explicit now, so this is a one-off for
 * the backlog: running it a second time should report zero.
 *
 * **What the two production rows actually hold**, so the operator knows what
 * `--apply` destroys before running it. Read-only, 2026-09-09, lengths rather
 * than content:
 *
 *   - PENDING, created 2026-02-18: one conversation, one message, **3
 *     characters**, unread, written by the user to themselves.
 *   - ACCEPTED, created 2026-04-15: one conversation, one message, **0
 *     characters**, unread, likewise.
 *
 * Both messages were written the same day as their request, which is
 * `requests.create` storing its opening message. So this deletes three
 * characters of one user's own text and an empty string — not correspondence
 * between two people, which is what makes it a different decision from
 * `cleanup-orphan-conversations` and its 1,258 retained messages.
 *
 * **The ACCEPTED row cannot be cleared by its owner**, which is why a script is
 * needed rather than a nudge. `requests.delete` refuses an ACCEPTED request
 * when both parties are in the same group, and for a self-request that
 * comparison is a user against themselves — so it matches whenever the user is
 * in any group at all, and the CONFLICT tells them to leave a carpool they are
 * really in to clear a request that is not real. That guard is fixed as
 * well; this script does not depend on the fix, because it writes through
 * Prisma rather than through the router.
 *
 * Deletion order is `requests.delete`'s, and the reuse is the point: both take
 * the request first, because the declared Conversation → Request cascade runs
 * the other way and would remove the request as a side effect. The conversation
 * set comes from `conversationsToDeleteWith`, the same helper the procedure
 * uses, so the script and the app cannot drift about which rows go together.
 *
 * Safety, because this deletes production rows:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - Every candidate is re-read immediately before its delete and skipped if
 *     it is no longer a self-request, so a row that changed under the run is
 *     left alone.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default
 *     500). A population this size should never approach it; a run that does is
 *     reporting a predicate error, not a backlog.
 *   - One transaction per candidate, so a partial run leaves a consistent
 *     database.
 *   - Every candidate and its message count is printed **before** it is
 *     deleted, because that line is the only record the row existed once the
 *     transaction commits.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-self-requests.ts            # report only
 *   npx ts-node scripts/cleanup-self-requests.ts --apply    # delete
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import { conversationsToDeleteWith } from "../src/server/db/conversationLink";
import { findSelfRequestIds } from "./check-self-requests";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 20;

export type Options = { apply: boolean; max: number };

/**
 * Exported so the test can pin the property that matters most: deleting
 * requires `--apply`, and no argument spelling reaches a delete by accident.
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

export type RequestRow = {
  id: string;
  fromUserId: string;
  toUserId: string;
  conversationId: string | null;
  dateCreated: Date;
};

export type Candidate = {
  id: string;
  userId: string;
  conversationId: string | null;
  dateCreated: Date;
  messages: number;
};

/**
 * The rows this run would delete, oldest first.
 *
 * Pure and exported for the same reason as `parseArgs`: this decides which rows
 * a run destroys, and it should be provable without a database. The predicate
 * itself is `findSelfRequestIds`, imported rather than restated so the check
 * and the cleanup cannot disagree about what a self-request is — the same
 * reason `cleanup-orphan-conversations` shares `findOrphanConversationIds` with
 * `conversationLink.ts`.
 *
 * Oldest first with `id` breaking ties, so two runs over the same rows report
 * them in the same order. `dateCreated` is not unique and a total order is what
 * makes a truncated sample mean the same thing twice.
 */
export const selectSelfRequests = (
  requests: readonly RequestRow[],
  messageCounts: ReadonlyMap<string, number>,
): Candidate[] => {
  const selfIds = new Set(findSelfRequestIds(requests));

  return requests
    .filter((request) => selfIds.has(request.id))
    .map((request) => ({
      id: request.id,
      userId: request.fromUserId,
      conversationId: request.conversationId,
      dateCreated: request.dateCreated,
      messages: request.conversationId
        ? (messageCounts.get(request.conversationId) ?? 0)
        : 0,
    }))
    .sort(
      (a, b) =>
        a.dateCreated.getTime() - b.dateCreated.getTime() ||
        a.id.localeCompare(b.id),
    );
};

const describeCandidate = (candidate: Candidate): string =>
  `${candidate.id}  user ${candidate.userId}  ` +
  `${candidate.messages} message(s)  ` +
  `conversation ${candidate.conversationId ?? "(none)"}  ` +
  `created ${candidate.dateCreated.toISOString().slice(0, 10)}`;

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const main = async () => {
  const { apply, max } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const requests = await prisma.request.findMany({
      select: {
        id: true,
        fromUserId: true,
        toUserId: true,
        conversationId: true,
        dateCreated: true,
      },
    });

    // Counted per candidate rather than in total, because the per-row number is
    // what tells the operator whether a row held anything a user typed.
    const linkedConversationIds = requests
      .filter((request) => request.fromUserId === request.toUserId)
      .flatMap((request) =>
        request.conversationId ? [request.conversationId] : [],
      );

    const messageCounts = new Map<string, number>();
    if (linkedConversationIds.length > 0) {
      const grouped = await prisma.message.groupBy({
        by: ["conversationId"],
        where: { conversationId: { in: linkedConversationIds } },
        _count: { _all: true },
      });
      for (const row of grouped) {
        messageCounts.set(row.conversationId, row._count._all);
      }
    }

    const candidates = selectSelfRequests(requests, messageCounts);
    const totalMessages = candidates.reduce(
      (sum, candidate) => sum + candidate.messages,
      0,
    );

    console.log(`${requests.length} request row(s)`);
    console.log(`${candidates.length} self-request row(s)`);
    console.log(`${totalMessages} message(s) inside them`);

    if (candidates.length === 0) {
      console.log("\n✓ no request has the same user on both ends.");
      return;
    }

    for (const candidate of candidates.slice(0, SAMPLE_SIZE)) {
      console.log(`    ${describeCandidate(candidate)}`);
    }
    if (candidates.length > SAMPLE_SIZE) {
      console.log(`    ... and ${candidates.length - SAMPLE_SIZE} more`);
    }

    if (candidates.length > max) {
      console.error(
        `\n✖ ${candidates.length} candidate(s) exceeds --max ${max}. ` +
          `Refusing to run. A self-request takes a deliberate API call, so a ` +
          `count this size is more likely a predicate error than a backlog — ` +
          `check the report above before raising the ceiling.`,
      );
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log(
        `\nDry run — nothing deleted. Re-run with --apply to delete ` +
          `${candidates.length} request(s), their conversation(s) and ` +
          `${totalMessages} message(s). That is irreversible.`,
      );
      return;
    }

    let deleted = 0;
    let deletedMessages = 0;
    let skipped = 0;
    const failures: string[] = [];

    for (const candidate of candidates) {
      // Re-read rather than trust the plan. Between building it and getting
      // here the row could have been deleted by its owner, or rewritten by
      // `requests.create`'s reopen branch, which swaps the direction of an
      // existing row — so a row that is no longer a self-request must be left
      // alone rather than deleted on the strength of a stale read.
      const current = await prisma.request.findUnique({
        where: { id: candidate.id },
        select: { id: true, fromUserId: true, toUserId: true },
      });

      if (!current || current.fromUserId !== current.toUserId) {
        console.log(
          `    ${candidate.id}  skipped, no longer a self-request${
            current ? "" : " (already gone)"
          }`,
        );
        skipped++;
        continue;
      }

      // Printed before the delete, not after: this line is the only record the
      // row existed once the transaction commits.
      console.log(`    ${describeCandidate(candidate)}  → deleting`);

      try {
        const removed = await prisma.$transaction(async (tx) => {
          // Request first, matching `requests.delete`. The other order trips
          // the declared Conversation → Request cascade, which removes the
          // request as a side effect and makes the delete below throw.
          await tx.request.delete({ where: { id: candidate.id } });

          const doomed = await tx.conversation.findMany({
            where: {
              OR: conversationsToDeleteWith({
                id: candidate.id,
                conversationId: candidate.conversationId,
              }),
            },
            select: { id: true },
          });

          if (doomed.length === 0) {
            return 0;
          }

          const ids = doomed.map((conversation) => conversation.id);

          // Messages explicitly rather than through the emulated cascade, so
          // the count reported is what was deleted rather than an assumption
          // about what Prisma did. Same reasoning as `requests.delete`.
          const messages = await tx.message.deleteMany({
            where: { conversationId: { in: ids } },
          });
          await tx.conversation.deleteMany({ where: { id: { in: ids } } });

          return messages.count;
        });

        // Incremented only once the transaction has committed, so a failure
        // cannot be reported as a deletion.
        deleted++;
        deletedMessages += removed;
      } catch (error) {
        failures.push(`${candidate.id}: ${reason(error)}`);
      }
    }

    console.log(
      `\n${deleted} request(s) and ${deletedMessages} message(s) deleted.`,
    );
    if (skipped > 0) {
      console.log(`${skipped} skipped — the row changed under the run.`);
    }
    if (failures.length > 0) {
      console.error(`\n✖ ${failures.length} failed:`);
      for (const failure of failures) {
        console.error(`    ${failure}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import the pure halves without opening a database
// connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(reason(error));
    process.exit(1);
  });
}
