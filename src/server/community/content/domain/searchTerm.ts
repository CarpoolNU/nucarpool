import { TextTooLongError } from "../../shared/errors";

/**
 * The search box's input, made safe to hand to a `LIKE`.
 *
 * Two separate jobs, kept apart because they belong to different layers. The
 * normalizer is policy — what counts as a search at all — and the service
 * calls it. The escaper is mechanism — what MySQL does with a `%` — and only
 * the Prisma repository calls it. Both live here because both are pure, and a
 * pure function is one that can be tested without a database.
 */

/**
 * The longest search term accepted.
 *
 * **Not a column width**, unlike every constant in `textLimits.ts` — nothing
 * stores a search term. It is a bound on work: the query is an unindexed scan
 * (see {@link escapeLikeWildcards}), and a 5000-character `LIKE` pattern costs
 * more per row than a short one while matching strictly less. 100 characters is
 * longer than any question anybody types into a search box.
 */
export const SEARCH_TERM_MAX_LENGTH = 100;

/**
 * Trims a search term, or reports that there is no search.
 *
 * **`null` rather than `""` for "no search"**, so the absence is a case the
 * type system makes callers handle rather than an empty string that would
 * quietly become `LIKE '%%'` — a predicate matching every row, which is the
 * unfiltered feed wearing a scan's clothing.
 *
 * **Throws over the cap rather than truncating.** Truncation would answer a
 * question the reader did not ask and present it as the answer to the one they
 * did; the Zod schema at the transport edge carries the same cap, so in the
 * ordinary path this throw is unreachable.
 */
export const normalizeSearchTerm = (raw: string | undefined): string | null => {
  const trimmed = raw?.trim() ?? "";

  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > SEARCH_TERM_MAX_LENGTH) {
    throw new TextTooLongError(
      `Search is too long — ${SEARCH_TERM_MAX_LENGTH} characters at most.`,
    );
  }

  return trimmed;
};

/**
 * Makes a term match itself literally inside a `LIKE` pattern.
 *
 * **Prisma's `contains` does not do this, and that is the whole reason this
 * exists.** `contains` compiles to `LIKE CONCAT('%', ?, '%')` with the term
 * bound as a parameter — so there is no injection here, the term can never be
 * read as SQL — but `%` and `_` keep their wildcard meaning *inside* the bound
 * value. Unescaped, a search for `50%` silently becomes "50 followed by
 * anything", and one for `_` matches every post with at least one character.
 *
 * **The backslash goes first.** MySQL's default `LIKE` escape character is the
 * backslash, so the escapes added below are themselves written with one; doing
 * the backslash pass second would escape those and hand the wildcards their
 * meaning straight back.
 */
export const escapeLikeWildcards = (term: string): string =>
  term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
