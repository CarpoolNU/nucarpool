import type { PrismaClient } from "@prisma/client";

/**
 * The per-sender cap on outbound mail, shared by every procedure in
 * `user.emails.*`.
 *
 * **What was wrong.** `sendRequestNotification` limited a sender by counting
 * their `Request` rows created in the last hour. Each of the three emails is
 * one-shot — the write that creates the thing being announced marks an email
 * as owed and the procedure clears that marker before sending — so the count
 * was the only thing standing between a caller and unlimited mail. It did not
 * stand: `requests.delete` hard-deletes the row the count was taken over, so
 * `create` -> notify -> `delete`, repeated, kept the count near one and
 * `rate_limited` never fired. The marker is per row, so each fresh row was
 * owed a fresh email, and the duplicate-`PENDING` guard in `requests.create`
 * never fired either because the row it would have found was gone. The same
 * loop reset the message cooldown, because deleting a request takes its
 * `Conversation` and every `Message` with it, and a new conversation has no
 * prior message to be within a cooldown of. The code's own comment conceded
 * the shape of this ("raises the cost of abuse and is not a cap").
 *
 * **What this does instead.** It counts *sends*, in a table the caller has no
 * procedure that writes to. Nothing a caller can delete is in the count, so
 * the loop above spends the budget and then stops. This is the "per-user cap
 * across all of `user.emails.*`" that `sendAcceptanceNotification`'s doc
 * comment recorded as not existing yet. See SCRUM-606.
 *
 * **It is a cap, not a cooldown.** A caller gets `EMAILS_PER_BUDGET_WINDOW`
 * sends per window however they spread them, across all three email kinds
 * together. The one-shot markers and the per-conversation message cooldown are
 * unchanged and still do their own jobs: this bounds the total, they stop one
 * thing being announced twice.
 */

/**
 * Windows are fixed buckets, not a sliding window.
 *
 * A sliding window needs a row per send to count over, which is a bigger table
 * and — more to the point — cannot be claimed in one statement, so the claim
 * would stop being atomic. The cost of fixed buckets is that a caller who
 * spends a full budget at the end of one window and another at the start of
 * the next sends `2 * EMAILS_PER_BUDGET_WINDOW` inside one window's length.
 * That is a bounded burst rather than the unbounded loop this replaces, and
 * the alternative trades a hard guarantee for a soft one.
 */
export const EMAIL_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * Sends allowed per sender per window, across every kind of mail.
 *
 * Higher than the ten the old request-only budget named, because this one is
 * shared: a user who sends requests, replies in those conversations and has
 * some of them accepted draws all three from here, and the old number was
 * never actually reached anyway. It has to leave an ordinary heavy user alone
 * — a rider working through a list of drivers is the platform working — while
 * bounding what one account can emit in an hour. Assumed to be at least one;
 * at zero the claim below would still admit the first send of a window.
 */
export const EMAILS_PER_BUDGET_WINDOW = 20;

/**
 * The Prisma surface this needs, narrow so the router tests' in-memory fakes
 * only have to supply `$executeRaw`. Both the base client and a transaction
 * client satisfy it.
 */
export type EmailBudgetStore = Pick<PrismaClient, "$executeRaw">;

/**
 * The bucket `now` falls in, floored to the window length so that every
 * sender shares one boundary and a row can be addressed by its pair without
 * reading anything first.
 */
export const budgetWindowStart = (now: Date): Date =>
  new Date(
    Math.floor(now.getTime() / EMAIL_BUDGET_WINDOW_MS) * EMAIL_BUDGET_WINDOW_MS,
  );

export type EmailBudgetClaim = {
  /** Whether this call got a send. `false` means the budget is spent. */
  claimed: boolean;
  /**
   * Gives the send back. Safe to call only on a claim that succeeded, and
   * safe to call once. A no-op on a refused claim, so a caller may call it
   * unconditionally on its failure path.
   */
  refund: () => Promise<void>;
};

/**
 * Takes one send from `userId`'s budget for the current window.
 *
 * **Two statements, and only the second one has to be atomic.**
 *
 * The first makes sure the row exists and deliberately changes nothing if it
 * already does — `user_id = user_id` is the standard no-op assignment. Of two
 * concurrent callers one inserts and the other hits the primary key and
 * no-ops, so it cannot reset or double-count a bucket, and it is idempotent
 * for the same reason.
 *
 * The second is the claim, and it is a real compare-and-swap: a single
 * `UPDATE` against one row, which InnoDB serialises on that row's lock. The
 * second statement waits for the first one's transaction, re-reads the row and
 * sees the incremented value, so of any number of concurrent callers exactly
 * `EMAILS_PER_BUDGET_WINDOW` of them succeed. This is the primitive
 * `claimRequestNotification`, `markRequestAccepted` and `reserveSeat` all use,
 * for the reason established against a real MySQL for those: `updateMany`
 * looks like the same statement and is not one under
 * `relationMode = "prisma"`, because it reads the matching ids first and then
 * updates by id, so concurrent callers all read the row before any of them
 * changes it and every one reports `count: 1`.
 *
 * **The cap is in the `WHERE`, not in an `IF()` on the assignment.** Writing
 * it as `SET send_count = IF(send_count < cap, send_count + 1, send_count)`
 * would be one statement instead of two and is subtly wrong: that `UPDATE`
 * always *matches* the row and only sometimes *changes* it, so telling a
 * claim from a refusal would depend on the client reporting changed rows
 * rather than matched rows — which is what `CLIENT_FOUND_ROWS` switches, and
 * is not a flag this code should be betting on. With the cap in the `WHERE`, a
 * spent budget does not match at all, so matched and changed are both zero and
 * the two readings agree.
 */
export const claimEmailBudget = async (
  prisma: EmailBudgetStore,
  userId: string,
  now: Date = new Date(),
): Promise<EmailBudgetClaim> => {
  const windowStart = budgetWindowStart(now);

  await prisma.$executeRaw`
    INSERT INTO \`email_send_budget\` (\`user_id\`, \`window_start\`, \`send_count\`)
    VALUES (${userId}, ${windowStart}, 0)
    ON DUPLICATE KEY UPDATE \`user_id\` = \`user_id\`
  `;

  const claimed = await prisma.$executeRaw`
    UPDATE \`email_send_budget\`
    SET \`send_count\` = \`send_count\` + 1
    WHERE \`user_id\` = ${userId}
      AND \`window_start\` = ${windowStart}
      AND \`send_count\` < ${EMAILS_PER_BUDGET_WINDOW}
  `;

  if (claimed === 0) {
    return { claimed: false, refund: async () => undefined };
  }

  return {
    claimed: true,
    refund: async () => {
      // `send_count > 0` so a refund can never drive the count negative,
      // which would hand out a free send later in the window.
      await prisma.$executeRaw`
        UPDATE \`email_send_budget\`
        SET \`send_count\` = \`send_count\` - 1
        WHERE \`user_id\` = ${userId}
          AND \`window_start\` = ${windowStart}
          AND \`send_count\` > 0
      `;
    },
  };
};
