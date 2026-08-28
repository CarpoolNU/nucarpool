/**
 * Measures what `user.requests.me` sends, before and after SCRUM-301.
 *
 * The ticket asks for before/after row counts and payload size. Row counts and
 * payload size are **not** the same story here, and reporting only one of them
 * would misdescribe the change:
 *
 *   - **Rows read** barely move. Prisma batches a to-one `include` into a single
 *     `WHERE id IN (...)`, so `include: { User: true }` on 600 messages read
 *     roughly *two* user rows, not 600 - the two people in the thread. The row
 *     saving is real but small: the deduplicated author rows, plus the
 *     `toUser`/`fromUser` joins that were fetched and then overwritten.
 *   - **Payload** is where the weight was. Those same two user rows were
 *     serialized once per message, each carrying `image` (`@db.MediumText`),
 *     `email` and `bio`. A 60-message thread shipped 60 copies.
 *
 * So the honest summary is "a small reduction in rows read, a large reduction in
 * bytes on the wire", and both are printed separately below.
 *
 * It is **read-only** - `findUnique`, `findMany` and `count`, no writes of any
 * kind - and it never prints the connection string.
 *
 * Usage:
 *   npx ts-node scripts/measure-requests-payload.ts --synthetic
 *   npx ts-node scripts/measure-requests-payload.ts
 *   npx ts-node scripts/measure-requests-payload.ts --user <userId>
 *
 * `--synthetic` needs no database at all: it builds the scenario the ticket
 * describes (10 conversations averaging 60 messages) from representative row
 * shapes and reports the same figures. Use it to see the size of the effect;
 * use a real database to confirm it against real data. Confirm `DATABASE_URL`
 * points where you intend before running without `--synthetic` - nothing is
 * written, but the numbers only mean something against representative data.
 */

import { PrismaClient } from "@prisma/client";
import superjson from "superjson";

/**
 * The message selection this change introduced, mirrored from
 * `src/server/router/user/requests.ts` so the comparison is against what
 * actually shipped.
 */
const NARROW_MESSAGE_FIELDS = [
  "id",
  "conversationId",
  "content",
  "userId",
  "isRead",
  "dateCreated",
] as const;

/** Bytes the tRPC transformer puts on the wire for a value. */
export const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(superjson.serialize(value)), "utf8");

/** Percentage reduction from `before` to `after`, floored at 0. */
export const reduction = (before: number, after: number): number => {
  if (before <= 0) return 0;
  return Math.max(0, Math.round(((before - after) / before) * 100));
};

export type RowCounts = {
  /** Request rows, unchanged by this change. */
  request: number;
  /** Conversation rows, unchanged. */
  conversation: number;
  /** Message rows, unchanged - this change narrows columns, not rows. */
  message: number;
  /** User rows: deduplicated authors plus the discarded to/from joins. */
  user: number;
  total: number;
};

/**
 * Rows the query pulls back, by table.
 *
 * `authorIds` and `counterpartIds` are counted as sets because each `include`
 * becomes one `IN (...)` under `relationMode = "prisma"`, so a user appearing in
 * fifty messages is still one row read.
 */
export const countRows = (input: {
  requests: number;
  conversations: number;
  messages: number;
  authorIds: string[];
  counterpartIds: string[];
  /** Whether the author and counterpart joins are issued at all. */
  joins: { messageAuthors: boolean; counterparts: boolean };
}): RowCounts => {
  const users = new Set<string>();
  if (input.joins.messageAuthors) {
    for (const id of input.authorIds) users.add(id);
  }
  if (input.joins.counterparts) {
    for (const id of input.counterpartIds) users.add(id);
  }

  const counts = {
    request: input.requests,
    conversation: input.conversations,
    message: input.messages,
    user: users.size,
  };

  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
};

/** Strips a message down to the columns the narrow `select` returns. */
export const narrowMessage = (
  message: Record<string, unknown>,
): Record<string, unknown> => {
  const narrowed: Record<string, unknown> = {};
  for (const field of NARROW_MESSAGE_FIELDS) {
    narrowed[field] = message[field];
  }
  return narrowed;
};

/**
 * A `user` row of representative width, for `--synthetic`.
 *
 * `image` dominates. Profile pictures are uploaded to S3 and the column holds a
 * key rather than the image itself, but it is `@db.MediumText` and old rows can
 * hold a data URL, so a modest 256 characters is used rather than a worst case -
 * the point is to avoid overstating the saving.
 */
const syntheticUser = (id: string) => ({
  id,
  name: `Student ${id}`,
  email: `${id}@northeastern.edu`,
  emailVerified: null,
  image: `profile-pictures/production/${id}`.padEnd(256, "x"),
  bio: "Looking for a carpool for my spring co-op.".padEnd(120, " "),
  preferredName: `Student ${id}`,
  pronouns: "they/them",
  permission: "USER",
  isOnboarded: true,
  tutorialCompleted: true,
  licenseSigned: true,
  dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  dateModified: new Date("2026-01-01T00:00:00.000Z"),
});

const syntheticMessage = (
  index: number,
  conversationId: string,
  authorId: string,
) => ({
  id: `message-${conversationId}-${index}`,
  conversationId,
  content:
    "Sounds good, I can pick you up at the usual spot tomorrow morning.".slice(
      0,
      120,
    ),
  isRead: index % 3 !== 0,
  userId: authorId,
  dateCreated: new Date(2026, 0, 1, 8, index),
});

/** The scenario from the ticket: 10 conversations averaging 60 messages. */
export const syntheticScenario = (
  conversations = 10,
  messagesPerConversation = 60,
) => {
  const caller = "user-caller";
  const rows = [];

  for (let c = 0; c < conversations; c++) {
    const counterpart = `user-counterpart-${c}`;
    const conversationId = `conversation-${c}`;
    const messages = [];

    for (let m = 0; m < messagesPerConversation; m++) {
      const authorId = m % 2 === 0 ? caller : counterpart;
      messages.push(syntheticMessage(m, conversationId, authorId));
    }

    rows.push({
      id: `request-${c}`,
      message: "",
      status: "ACCEPTED",
      fromUserId: caller,
      toUserId: counterpart,
      conversationId,
      dateCreated: new Date(2026, 0, 1),
      counterpartId: counterpart,
      messages,
    });
  }

  return { caller, rows };
};

type MeasuredRow = {
  id: string;
  counterpartId: string;
  messages: Record<string, unknown>[];
};

/**
 * Both payload shapes for the same rows.
 *
 * `before` re-attaches what the old query sent: a whole `User` per message, and
 * the counterpart join that the resolver's `...req` spread then overwrote.
 * `after` is the narrow selection.
 */
export const buildPayloads = (
  rows: MeasuredRow[],
  userById: (id: string) => Record<string, unknown>,
) => {
  const before = rows.map((row) => ({
    ...row,
    counterpart: userById(row.counterpartId),
    messages: row.messages.map((message) => ({
      ...message,
      User: userById(String(message.userId)),
    })),
  }));

  const after = rows.map((row) => ({
    ...row,
    messages: row.messages.map(narrowMessage),
  }));

  return { before, after };
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

const report = (
  label: string,
  rows: MeasuredRow[],
  userById: (id: string) => Record<string, unknown>,
) => {
  const messages = rows.reduce((sum, row) => sum + row.messages.length, 0);
  const authorIds = rows.flatMap((row) =>
    row.messages.map((message) => String(message.userId)),
  );
  const counterpartIds = rows.map((row) => row.counterpartId);

  const beforeRows = countRows({
    requests: rows.length,
    conversations: rows.length,
    messages,
    authorIds,
    counterpartIds,
    joins: { messageAuthors: true, counterparts: true },
  });
  const afterRows = countRows({
    requests: rows.length,
    conversations: rows.length,
    messages,
    authorIds,
    counterpartIds,
    joins: { messageAuthors: false, counterparts: false },
  });

  const { before, after } = buildPayloads(rows, userById);
  const beforeBytes = serializedBytes(before);
  const afterBytes = serializedBytes(after);

  console.log(label);
  console.log(
    `  conversations        : ${rows.length}, ${messages} message(s) total`,
  );
  console.log(
    `  rows read  before    : ${beforeRows.total} (user: ${beforeRows.user})`,
  );
  console.log(
    `  rows read  after     : ${afterRows.total} (user: ${afterRows.user})`,
  );
  console.log(
    `  rows read  reduction : ${reduction(beforeRows.total, afterRows.total)}%`,
  );
  console.log(`  payload    before    : ${formatBytes(beforeBytes)}`);
  console.log(`  payload    after     : ${formatBytes(afterBytes)}`);
  console.log(
    `  payload    reduction : ${reduction(beforeBytes, afterBytes)}% fewer bytes`,
  );
  console.log(
    `  per message          : ${Math.round(beforeBytes / Math.max(messages, 1))} B -> ${Math.round(afterBytes / Math.max(messages, 1))} B`,
  );
  console.log();
};

const runSynthetic = () => {
  const { rows } = syntheticScenario();
  const users = new Map<string, Record<string, unknown>>();
  const userById = (id: string) => {
    if (!users.has(id)) users.set(id, syntheticUser(id));
    return users.get(id)!;
  };

  console.log(
    "synthetic: the scenario from SCRUM-301, no database required.\n" +
      "Row shapes are representative, not measured - see syntheticUser above.\n",
  );
  report("10 conversations x 60 messages", rows, userById);
};

const runAgainstDatabase = async (requestedUserId?: string) => {
  const prisma = new PrismaClient();

  try {
    // Whoever has the most conversation traffic, since that is the case the
    // ticket is about. A user with one empty thread would understate it.
    const subjectId =
      requestedUserId ??
      (
        await prisma.request.findFirst({
          where: { conversationId: { not: null } },
          orderBy: { dateCreated: "desc" },
          select: { fromUserId: true },
        })
      )?.fromUserId;

    if (!subjectId) {
      console.log(
        "No request with a conversation found. This database has nothing to measure.",
      );
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: subjectId },
      include: {
        sentRequests: {
          include: { conversation: { include: { messages: true } } },
        },
        receivedRequests: {
          include: { conversation: { include: { messages: true } } },
        },
      },
    });

    if (!user) {
      console.log(`No user with id '${subjectId}'.`);
      return;
    }

    const rows: MeasuredRow[] = [
      ...user.sentRequests.map((request) => ({
        id: request.id,
        counterpartId: request.toUserId,
        messages: (request.conversation?.messages ?? []) as unknown as Record<
          string,
          unknown
        >[],
      })),
      ...user.receivedRequests.map((request) => ({
        id: request.id,
        counterpartId: request.fromUserId,
        messages: (request.conversation?.messages ?? []) as unknown as Record<
          string,
          unknown
        >[],
      })),
    ];

    const authorIds = new Set(
      rows.flatMap((row) => row.messages.map((m) => String(m.userId))),
    );
    const counterpartIds = new Set(rows.map((row) => row.counterpartId));
    const joined = await prisma.user.findMany({
      where: { id: { in: [...authorIds, ...counterpartIds] } },
    });
    const byId = new Map(
      joined.map((row) => [row.id, row as unknown as Record<string, unknown>]),
    );

    const totalMessages = await prisma.message.count();
    console.log(
      `database: ${totalMessages} message(s) total; measured for one user`,
    );
    console.log();
    report(`requests.me for a single user`, rows, (id) => byId.get(id) ?? {});
  } finally {
    await prisma.$disconnect();
  }
};

const main = async () => {
  const args = process.argv.slice(2);

  if (args.includes("--synthetic")) {
    runSynthetic();
    return;
  }

  const userFlag = args.indexOf("--user");
  await runAgainstDatabase(userFlag === -1 ? undefined : args[userFlag + 1]);
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
