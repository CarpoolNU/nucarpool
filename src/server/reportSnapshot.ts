import { z } from "zod";

/**
 * The copy of a conversation a report keeps (SCRUM-555).
 *
 * A report keeps its own copy because either party can delete the request
 * behind a conversation, and `requests.delete` takes the conversation and
 * every message with it. Without a copy, the person being reported could
 * delete the evidence as soon as they were blocked.
 *
 * The server builds it, never the client. A snapshot sent by the reporter
 * could contain words the other person never wrote.
 */

/** One message in a snapshot. `senderId` is a user id. */
export type SnapshotMessage = {
  senderId: string;
  content: string;
  sentAt: Date;
};

/** The `message` columns a snapshot is built from. */
export type SnapshotSourceRow = {
  userId: string;
  content: string;
  dateCreated: Date;
};

/**
 * Serialises `rows`, oldest first, for `report.conversation_snapshot`.
 *
 * Takes rows in any order and sorts them itself. The query reads newest first
 * to cap at the most recent messages, and the admin queue reads the thread top
 * to bottom.
 */
export const buildConversationSnapshot = (
  rows: readonly SnapshotSourceRow[],
): string =>
  JSON.stringify(
    [...rows]
      .sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime())
      .map((row) => ({
        senderId: row.userId,
        content: row.content,
        sentAt: row.dateCreated.toISOString(),
      })),
  );

const snapshotSchema = z.array(
  z.object({
    senderId: z.string(),
    content: z.string(),
    sentAt: z.coerce.date(),
  }),
);

/**
 * Reads a stored snapshot back. Null for a report with no snapshot, and for
 * one that does not parse, so a single bad row cannot break the admin queue.
 */
export const parseConversationSnapshot = (
  stored: string | null,
): SnapshotMessage[] | null => {
  if (stored === null) {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(stored);
  } catch {
    return null;
  }

  const parsed = snapshotSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
};
