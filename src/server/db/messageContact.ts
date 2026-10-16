import type { TransactionClient } from "./client";

/**
 * The durable record that two users corresponded, written when they part.
 *
 * `MessageContact` in `schema.prisma` carries the reasoning about the row
 * itself. This module is the two halves of writing one: {@link buildContact}
 * decides *whether* a deletion produces a row and what it holds, and
 * {@link recordContact} writes it without ever being able to fail the
 * deletion.
 *
 * **The split is the testable part**, exactly as in
 * {@link file://./carpoolPairing.ts}. Which pair a deletion records, and in
 * which order, is a pure function of two ids — so it is decided here and
 * asserted in `messageContact.test.ts` against a table of cases, rather than
 * inferred from a database test that can only show the end state of one
 * scenario at a time.
 *
 * **Why this record is written on delete.** The surface it feeds —
 * `user.pastConnections.me` — exists so that report and block can be reached
 * after a connection has ended. A *live* request needs nothing from it: the
 * conversation still exists and `UserActionsMenu` already reaches it from
 * `MessageHeader`. Only a deleted request leaves a counterpart unreachable,
 * because `requests.delete` takes the conversation and every message with it
 * and no `CarpoolPairing` row exists for a pair who never shared a group. So
 * the delete is both the moment the record becomes necessary and the moment
 * contact genuinely ended, which is what `endedAt` has to mean for the
 * retention window to be honest. Recording at the other obvious moment — the
 * first message — would have written a row per request ever sent, since
 * `requests.create` writes the opening message itself (`requests.ts:549-553`).
 */

/**
 * Retention, decided on SCRUM-676 (2026-10-15).
 *
 * Deliberately the same twelve months as `PAIRING_RETENTION_MONTHS`, and
 * deliberately a separate constant rather than an import of it. The two
 * windows agree today because SCRUM-676 chose not to diverge from SCRUM-636 —
 * two windows for two kinds of past connection would be hard to explain to a
 * user and harder to sweep correctly — but they are two policies that happen
 * to coincide, not one policy. Importing the pairing constant here would mean
 * a future decision to shorten one silently shortened the other, which is a
 * privacy change nobody reviewed.
 */
export const CONTACT_RETENTION_MONTHS = 12;

/**
 * The oldest `endedAt` still inside the retention window.
 *
 * Month arithmetic rather than a day or millisecond count, for the reason
 * `pairingRetentionCutoff` gives: `setMonth` lands on the same day of the
 * month a year earlier regardless of leap days or the two daylight-saving
 * transitions in between, where `365 * 24 * 60 * 60 * 1000` drifts by an hour
 * twice a year and by a day every fourth.
 *
 * This is the boundary the reader and the sweep have to agree on — the reader
 * retains `endedAt >= cutoff` and `scripts/expire-message-contacts.ts` deletes
 * `endedAt < cutoff`. Exactly complementary, from this one function, so no
 * row can ever be both listed and sweepable, or neither.
 */
export const contactRetentionCutoff = (now: Date): Date => {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - CONTACT_RETENTION_MONTHS);
  return cutoff;
};

/** A `MessageContact` row, before it is written. */
export type ContactRow = {
  userAId: string;
  userBId: string;
  endedAt: Date;
};

/**
 * The row a deleted request records, or null.
 *
 * Null for a **self-request**, where `fromUserId === toUserId`. Those exist:
 * `requests.delete` exempts them from its carpooling guard because the
 * membership comparison degenerates when one user is on both sides, and two
 * rows are in production awaiting `scripts/cleanup-self-requests.ts`.
 * Recording one would pair a user with themselves, and that row would then
 * surface in their own past-connections list as an offer to report and block
 * themselves.
 *
 * The ids are sorted into a canonical order so that whichever party deletes
 * the request, the pair lands in the same two columns. That is what lets the
 * `@@unique([userAId, userBId])` collapse both directions to one row, and what
 * makes "did these two correspond" a single indexed lookup for a reader who
 * knows the pair but not who sent the request.
 */
export const buildContact = ({
  fromUserId,
  toUserId,
  endedAt,
}: {
  fromUserId: string;
  toUserId: string;
  endedAt: Date;
}): ContactRow | null => {
  if (fromUserId === toUserId) {
    return null;
  }

  const [userAId, userBId] =
    fromUserId < toUserId ? [fromUserId, toUserId] : [toUserId, fromUserId];

  return { userAId, userBId, endedAt };
};

/**
 * Writes the row, inside the caller's transaction, without being able to fail
 * it.
 *
 * **Both halves of that sentence are requirements, and they pull against each
 * other** — the same tension `recordPairings` resolves, and resolved the same
 * way. The write has to be *inside* the delete transaction, because a contact
 * recorded by a transaction that then rolled back would describe a deletion
 * that never happened, and one written afterwards would be missing whenever
 * the process died in between. But a contact write that *failed* the delete
 * would strand a user on a request they pressed delete on — and the open
 * exits are a rule this repository holds above almost everything else
 * (`src/server/db/blocks.ts`, SCRUM-554).
 *
 * The resolution is this `catch`. Prisma's interactive transactions roll back
 * when the callback throws, so swallowing the error here is what keeps the
 * delete committing — and InnoDB rolls back only the failed statement, not
 * the transaction, so the surrounding writes are intact rather than merely
 * uncommitted. **The delete wins; the record is best-effort.**
 *
 * **The log is not a control.** It records the loss for whoever is reading at
 * the time, but this repository has no known destination for deployed server
 * logs, so nothing alerts on it and nothing reconciles it afterwards. The
 * honest statement of the guarantee is that a row is written on every deletion
 * *whose upsert succeeds*, and that the only thing protecting it is that the
 * upsert references no other row and so has very little to fail on.
 *
 * An **upsert** rather than a create, which is this record's one shape
 * difference from `CarpoolPairing`. The `@@unique` on the pair bounds the
 * table at one row per pair however many times they correspond and part, and
 * moving `endedAt` forward on each deletion means the retention clock measures
 * the most recent contact — the correct reading of "twelve months from the end
 * of contact". It also means the reader needs no dedupe pass, where
 * `carpoolPairings` had to collapse rows per counterpart in application code.
 *
 * Returns whether a row was written, which the caller does not use and the
 * tests do: it is how "the upsert failed but the delete stood" is told apart
 * from "the upsert succeeded" without reading the table.
 */
export const recordContact = async (
  tx: TransactionClient,
  row: ContactRow | null,
): Promise<boolean> => {
  if (row === null) {
    return false;
  }

  try {
    await tx.messageContact.upsert({
      where: {
        userAId_userBId: { userAId: row.userAId, userBId: row.userBId },
      },
      update: { endedAt: row.endedAt },
      create: row,
    });
    return true;
  } catch (error) {
    console.error(
      "Could not record a message contact; the request deletion itself still stands",
      error,
    );
    return false;
  }
};
