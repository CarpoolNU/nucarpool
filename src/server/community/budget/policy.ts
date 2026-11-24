import type { CommunityBudgetAction } from "@prisma/client";

/**
 * The per-user, per-action caps and the window arithmetic they are counted in.
 *
 * Pure, and deliberately one file. Everything in this module that is a *policy*
 * decision lives here; the repository below it only executes. That split is what
 * lets a limit be retuned without touching SQL, and the SQL be read without
 * reasoning about windows.
 *
 * **Fixed buckets, not a sliding window.** Parent spec §8.1 settles this: a
 * sliding window needs a row per action to count over, which cannot be claimed
 * in a single statement — so the claim would stop being atomic, which is the one
 * property the whole design rests on. The cost of fixed buckets is that a caller
 * who spends a full budget at the end of one window and another at the start of
 * the next gets twice the limit inside one window's length. That is a bounded
 * burst, and a bounded failure is the trade this design makes for an atomic
 * claim.
 *
 * **The numbers below are assumptions.** Parent spec §8.2 says so plainly:
 * there is no traffic data, and these are starting points to be tuned against
 * staging. They are kept in one table with their rationale attached so that
 * tuning is a one-file edit.
 */

export type BudgetRule = {
  /** Actions allowed per window. Assumed to be at least one. */
  limit: number;
  /** The window length, which also fixes where the bucket boundaries fall. */
  windowMs: number;
};

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Every action, with the limit and window from parent spec §8.2.
 *
 * **Typed as a total `Record`, so the compiler keeps it exhaustive.** Adding a
 * member to `CommunityBudgetAction` is then a compile error here rather than a
 * silently unbudgeted action — which matters because the enum already carries
 * more members than this cut wires to procedures.
 */
export const BUDGET_RULES: Record<CommunityBudgetAction, BudgetRule> = {
  /**
   * Bounds handle enumeration through *failed* claims, which is why a refused
   * claim keeps its charge. The window is a day rather than an hour because
   * choosing a handle is a once-ever act: five attempts is generous for a
   * person settling on a name and useless for probing a namespace.
   */
  HANDLE_CLAIM: { limit: 5, windowMs: DAY_MS },

  /** Well above a heavy legitimate user; a flood is what this stops. */
  POST_CREATE: { limit: 10, windowMs: HOUR_MS },

  /**
   * Conversation is the product, so this is anti-flood only and is set high
   * enough that a busy thread never meets it.
   */
  COMMENT_CREATE: { limit: 60, windowMs: HOUR_MS },

  /**
   * Bounds automated vote traffic. `unvote` draws from this same bucket — see
   * `votes.ts` — so a vote/unvote cycle spends two and a hundred cycles an hour
   * exhausts it.
   */
  VOTE: { limit: 200, windowMs: HOUR_MS },

  /** Same reasoning as `VOTE`; `unsave` draws from this bucket too. */
  SAVE: { limit: 200, windowMs: HOUR_MS },

  /**
   * Bounds mass-reporting used as harassment.
   *
   * **Nothing claims this yet** — reports do not exist. The entry is here
   * because the table is exhaustive by type, and so that wiring reports is the
   * middleware call §7 promised rather than a policy decision deferred to
   * whoever builds them.
   */
  REPORT_CREATE: { limit: 20, windowMs: DAY_MS },

  /**
   * Post and comment edits, both drawing from one bucket.
   *
   * **One action for two content types**, following `VOTE` and `SAVE`, which
   * each cover a pair: the thing being bounded is edit churn, and splitting it
   * would let a script alternate post and comment edits to get twice the cap.
   *
   * Set generously, because editing is overwhelmingly a typo fix and a person
   * correcting themselves must not be refused. What this stops is the one
   * abuse the edit path adds that `POST_CREATE` does not already cover: a
   * reported post whose body is rewritten repeatedly to outrun a moderator
   * reading it — the `contentSnapshot` on a report is what makes that
   * pointless, and this is what makes it slow.
   */
  CONTENT_EDIT: { limit: 60, windowMs: HOUR_MS },

  /**
   * Post and comment deletions, in one bucket for `CONTENT_EDIT`'s reason.
   *
   * **Deliberately above `POST_CREATE` and well below `COMMENT_CREATE`.**
   * Removing your own writing is the one action a person must always be able
   * to take, so the cap is set where no honest user reaches it; a delete also
   * cannot amplify anything, because the content it removes was already capped
   * on the way in.
   */
  CONTENT_DELETE: { limit: 60, windowMs: HOUR_MS },
};

/**
 * The bucket `now` falls in, floored to `windowMs`.
 *
 * Flooring epoch milliseconds — rather than zeroing calendar fields — is what
 * makes every user share one boundary, so a bucket row is addressable by its
 * key without reading anything first. That is the precondition for the claim
 * being one statement.
 *
 * The window arrives as an argument instead of being read from the table, so
 * the arithmetic is testable on its own. A day floors to midnight UTC because
 * the epoch itself begins at midnight UTC; it is not a rolling 24 hours, and
 * parent spec §8.2's "24h" means the former.
 */
export const budgetWindowStart = (now: Date, windowMs: number): Date =>
  new Date(Math.floor(now.getTime() / windowMs) * windowMs);
