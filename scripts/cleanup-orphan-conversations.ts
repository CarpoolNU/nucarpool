/**
 * Delete `Conversation` rows whose `requestId` points at a `Request` that is
 * gone, and the `Message` rows inside them.
 *
 * The cascade in the schema points the wrong way for this: `Request` holds the
 * foreign key, so `onDelete: Cascade` runs Conversation → Request. Nothing ran
 * Request → Conversation, so every decline, withdrawal and "Leave
 * Conversation" left a conversation and its messages behind. `requests.delete`
 * now removes both in one transaction (SCRUM-295), which makes this a one-off
 * for the backlog rather than a recurring chore — running it a second time
 * should report zero.
 *
 * **These rows are unreachable, not merely untidy.**
 * `getConversationMessages` looks the request up first and throws NOT_FOUND
 * without it; the unread count joins through `conversation.request.some(...)`,
 * which matches nothing. No user-facing path can read one. What does count
 * them is `admin.getDashboardStats`, which is why the dashboard's conversation
 * figure and its messages-per-conversation average drift upward permanently.
 *
 * **This deletes real message content.** 11 conversations holding 25 messages
 * on production-derived staging when SCRUM-295 was measured; production is
 * unknown, because read queries against the PlanetScale `main` branch return
 * 403 with the credentials in this repository. The dry run prints the message
 * count per conversation before anything is written, and that is the number to
 * look at: these are words two people typed to each other, and nobody can read
 * them any more. Deleting them is the privacy-respecting answer rather than a
 * tidy-up, but it is irreversible, so read the report.
 *
 * Safety, because this deletes production rows:
 *
 *   - **Dry run by default.** Nothing is deleted without `--apply`.
 *   - Every candidate is re-checked immediately before its delete, against
 *     rows read after the plan was built, by *both* links — a request that
 *     appeared pointing at it either way rescues it.
 *   - Refuses to proceed when the candidate count exceeds `--max` (default
 *     500). A logic error that classified every conversation as an orphan
 *     stops here rather than emptying the messaging history.
 *   - Deletes one row at a time by primary key. Slower than deleteMany, and
 *     deliberately so: a partial run leaves a consistent database.
 *
 * `relationMode = "prisma"` means MySQL holds no foreign key from
 * `conversation` to `request`, so "orphan" has to be computed here rather than
 * asked of the database. The `Message` rows go through Prisma's emulated
 * cascade, which is why they are deleted by the client rather than by MySQL.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-orphan-conversations.ts            # report only
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --apply    # delete
 *   npx ts-node scripts/cleanup-orphan-conversations.ts --apply --max 2000
 *
 * Confirm DATABASE_URL points where you intend before using --apply. This
 * script does not print it.
 */

import { PrismaClient } from "@prisma/client";
import { findOrphanConversationIds } from "../src/server/db/conversationLink";

const DEFAULT_MAX = 500;
/** Candidates listed in the report before it truncates. */
const SAMPLE_SIZE = 20;

export type Options = { apply: boolean; max: number };

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
    const [conversations, requests] = await Promise.all([
      prisma.conversation.findMany({
        select: { id: true, requestId: true, dateCreated: true },
      }),
      prisma.request.findMany({ select: { id: true } }),
    ]);

    const orphanIds = findOrphanConversationIds(
      conversations,
      requests.map((row) => row.id),
    );

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

    const totalMessages = orphanIds.reduce(
      (sum, id) => sum + (messageCounts.get(id) ?? 0),
      0,
    );

    console.log(`${conversations.length} conversation row(s)`);
    console.log(`${requests.length} request row(s)`);
    console.log(`${orphanIds.length} conversation(s) with no request`);
    console.log(`${totalMessages} message(s) inside them`);

    if (orphanIds.length === 0) {
      console.log("\n✓ every conversation belongs to a request.");
      return;
    }

    const byId = new Map(conversations.map((row) => [row.id, row]));
    for (const id of orphanIds.slice(0, SAMPLE_SIZE)) {
      const row = byId.get(id);
      const count = messageCounts.get(id) ?? 0;
      console.log(
        `    ${id}  ${count} message(s)  request ${row?.requestId} (gone)` +
          `  created ${row?.dateCreated.toISOString().slice(0, 10)}`,
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
        `\nDry run — nothing deleted. Re-run with --apply to delete ` +
          `${orphanIds.length} conversation(s) and ${totalMessages} message(s). ` +
          `That is irreversible.`,
      );
      return;
    }

    let deleted = 0;
    let deletedMessages = 0;
    let rescued = 0;

    for (const id of orphanIds) {
      // Re-check against current rows, by both links. Between building the
      // plan and getting here a request could have been pointed at this row —
      // `findOrCreateConversation` keys on `requestId`, and a reopen writes
      // `Request.conversationId` — so either reference rescues it.
      const row = byId.get(id);
      const referencing = await prisma.request.count({
        where: {
          OR: [{ conversationId: id }, ...(row ? [{ id: row.requestId }] : [])],
        },
      });

      if (referencing > 0) {
        rescued++;
        continue;
      }

      // Explicit rather than relying on the emulated cascade, so the count
      // reported below is the number actually removed rather than an
      // assumption about what Prisma did.
      const messages = await prisma.message.deleteMany({
        where: { conversationId: id },
      });
      await prisma.conversation.delete({ where: { id } });

      deletedMessages += messages.count;
      deleted++;
    }

    console.log(
      `\n✓ deleted ${deleted} conversation(s) and ${deletedMessages} message(s)`,
    );
    if (rescued > 0) {
      console.log(
        `  ${rescued} conversation(s) were referenced by a request by the ` +
          `time they were reached and were left alone`,
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
