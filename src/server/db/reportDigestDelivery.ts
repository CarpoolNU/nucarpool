import { ReportDigestStatus } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { ReportingWindow } from "../reportDigestWindow";

/**
 * Whether a weekly reporting window has been delivered, and who is currently
 * trying to deliver it.
 *
 * Six requirements land on this one file, and they are deliberately satisfied
 * by a single mechanism rather than six:
 *
 *  1. **The same window cannot be mailed twice.** `SENT` is terminal and no
 *     claim can be taken over it.
 *  2. **Retries are safe.** A window that was claimed and not delivered goes
 *     back to being claimable, so running the job again finishes the job.
 *  3. **A failed SES send does not mark a digest delivered.** `SENT` is
 *     written by `markDigestSent` only, which the caller reaches on the
 *     success path alone.
 *  4. **Concurrent executions cannot duplicate a digest.** The claim is a
 *     compare-and-swap on one row, so of any number of simultaneous runs
 *     exactly one proceeds.
 *  5. **Window boundaries are deterministic.** They are derived in
 *     `reportDigestWindow.ts` and only recorded here.
 *  6. **Deployments and restarts do not lose scheduling state.** The state is
 *     a row in MySQL, so it does not live in a process, a timer, or a file on
 *     an instance that Amplify will replace.
 *
 * ## Why this is a raw `UPDATE` and not `updateMany`
 *
 * The claim has to be a real compare-and-swap: a single `UPDATE` against one
 * row, which InnoDB serialises on that row's lock, with the guard in the
 * `WHERE` so that a refused claim matches nothing and the affected count is
 * zero. That is the primitive `claimEmailBudget`, `claimRequestNotification`,
 * `markRequestAccepted` and `reserveSeat` all use.
 *
 * `updateMany` looks like the same statement and is not one under
 * `relationMode = "prisma"`: it reads the matching ids first and then updates
 * by id, so concurrent callers all read the row before any of them changes it
 * and every one reports `count: 1` — verified against a real MySQL. Using it
 * here would mean every concurrent run believed it had won the claim, which is
 * the one failure this table exists to prevent.
 *
 * For the same reason the guard is in the `WHERE` rather than in an `IF()` on
 * an assignment: an `UPDATE` that always matches and only sometimes changes
 * makes telling a claim from a refusal depend on whether the client reports
 * matched or changed rows, which is what `CLIENT_FOUND_ROWS` switches and is
 * not a flag this code should bet on.
 */

/**
 * How long a claim is honoured before another run may take it over.
 *
 * This is the trade between two failure modes, and neither is removable:
 *
 *  - **Too short** and a slow but healthy run loses its claim mid-flight. It
 *    then cannot mark the window `SENT` (the token check refuses it), so a
 *    digest that was in fact delivered looks undelivered and the run that
 *    took over sends a second copy.
 *  - **Too long** and a window whose run died — an instance recycled, a
 *    process killed — stays locked for that whole period, delaying the digest.
 *
 * Fifteen minutes is far longer than the job needs. Its work is one indexed
 * read over a week of reports, one read of the admin roster and one
 * `SendTemplatedEmail`; the realistic worst case is seconds, and SES's own
 * timeouts are well inside this. Erring long is correct here because the
 * costs are asymmetric: a late digest is an inconvenience and a duplicate
 * digest is the thing the table exists to prevent.
 */
export const DIGEST_CLAIM_LEASE_MS = 15 * 60 * 1000;

/**
 * The Prisma surface this needs. Narrow, so a router-level fake only has to
 * supply these two; both the base client and a transaction client satisfy it.
 */
export type ReportDigestStore = Pick<
  PrismaClient,
  "$executeRaw" | "reportDigestDelivery"
>;

export type DigestClaim =
  | { claimed: true; token: string; attempt: number }
  | {
      claimed: false;
      /**
       * `already_sent` — this window has been delivered and must not be again.
       * `held_by_another_run` — somebody else holds an unexpired claim.
       */
      reason: "already_sent" | "held_by_another_run";
    };

/**
 * Takes ownership of a window, or explains why it could not.
 *
 * **Two statements, and only the second has to be atomic.**
 *
 * The first makes the row exist and deliberately changes nothing if it already
 * does — `window_start = window_start` is the standard no-op assignment, the
 * same one `claimEmailBudget` uses. Of two concurrent callers one inserts and
 * the other hits the primary key and no-ops, so it can neither reset a
 * window's status nor lose its attempt count, and it is idempotent for the
 * same reason.
 *
 * The second is the claim. A window is claimable when it is not `SENT` and
 * either nobody holds it or the holder's lease has expired; all three
 * conditions are in the `WHERE`, so a refusal matches no row at all.
 *
 * `token` must be unique per run — the caller supplies it so that the value is
 * visible in tests rather than generated invisibly in here.
 */
export const claimDigestWindow = async (
  prisma: ReportDigestStore,
  window: ReportingWindow,
  token: string,
  now: Date = new Date(),
): Promise<DigestClaim> => {
  const leaseCutoff = new Date(now.getTime() - DIGEST_CLAIM_LEASE_MS);

  await prisma.$executeRaw`
    INSERT INTO \`report_digest_delivery\`
      (\`window_start\`, \`window_end\`, \`status\`, \`attempt_count\`)
    VALUES (${window.start}, ${window.end}, 'PENDING', 0)
    ON DUPLICATE KEY UPDATE \`window_start\` = \`window_start\`
  `;

  const claimed = await prisma.$executeRaw`
    UPDATE \`report_digest_delivery\`
    SET \`status\` = 'CLAIMED',
        \`claim_token\` = ${token},
        \`claimed_at\` = ${now},
        \`attempt_count\` = \`attempt_count\` + 1
    WHERE \`window_start\` = ${window.start}
      AND \`status\` <> 'SENT'
      AND (
        \`status\` <> 'CLAIMED'
        OR \`claimed_at\` IS NULL
        OR \`claimed_at\` <= ${leaseCutoff}
      )
  `;

  if (claimed === 0) {
    // Only reached on a refusal, so the extra read costs nothing in the
    // ordinary case. It exists to tell the two refusals apart: "already
    // delivered" is the system working and "somebody else is sending it" is
    // too, but an operator reading a log needs to know which.
    const row = await prisma.reportDigestDelivery.findUnique({
      where: { windowStart: window.start },
      select: { status: true },
    });

    return {
      claimed: false,
      reason:
        row?.status === ReportDigestStatus.SENT
          ? "already_sent"
          : "held_by_another_run",
    };
  }

  const row = await prisma.reportDigestDelivery.findUnique({
    where: { windowStart: window.start },
    select: { attemptCount: true },
  });

  return { claimed: true, token, attempt: row?.attemptCount ?? 1 };
};

/**
 * Records that the digest for this window was delivered.
 *
 * **Call this only after SES has resolved.** It is the single writer of
 * `SENT`, which is what makes "digest state only advances after successful
 * delivery" a property of the code rather than an intention.
 *
 * Requires the caller still to hold the claim, by both status and token. A run
 * whose lease expired and whose window was taken over therefore cannot mark it
 * delivered — it returns `false`, and the caller has to treat that as the
 * serious case it is: mail went out that this table does not record. Nothing
 * can make that impossible without a transactional mail server, so the lease
 * is set long enough that it does not happen in practice and the caller logs
 * loudly when it does.
 */
export const markDigestSent = async (
  prisma: ReportDigestStore,
  window: ReportingWindow,
  token: string,
  delivered: { reportCount: number; recipientCount: number },
  now: Date = new Date(),
): Promise<boolean> => {
  const updated = await prisma.$executeRaw`
    UPDATE \`report_digest_delivery\`
    SET \`status\` = 'SENT',
        \`sent_at\` = ${now},
        \`report_count\` = ${delivered.reportCount},
        \`recipient_count\` = ${delivered.recipientCount},
        \`claim_token\` = NULL
    WHERE \`window_start\` = ${window.start}
      AND \`status\` = 'CLAIMED'
      AND \`claim_token\` = ${token}
  `;

  return updated === 1;
};

/**
 * Gives the claim back without delivering, so the window can be retried.
 *
 * Clears the token rather than waiting for the lease to expire: a send that
 * has already failed should be retryable immediately, and leaving the row
 * `CLAIMED` would make the next run wait fifteen minutes to discover the same
 * thing. `FAILED` rather than back to `PENDING` so that the attempt is visible
 * to somebody reading the table; both are claimable and the distinction is
 * only for a human.
 *
 * Guarded by the token for the same reason `markDigestSent` is — a run that
 * lost its claim must not release somebody else's.
 */
export const releaseDigestClaim = async (
  prisma: ReportDigestStore,
  window: ReportingWindow,
  token: string,
): Promise<boolean> => {
  const updated = await prisma.$executeRaw`
    UPDATE \`report_digest_delivery\`
    SET \`status\` = 'FAILED',
        \`claim_token\` = NULL,
        \`claimed_at\` = NULL
    WHERE \`window_start\` = ${window.start}
      AND \`status\` = 'CLAIMED'
      AND \`claim_token\` = ${token}
  `;

  return updated === 1;
};
