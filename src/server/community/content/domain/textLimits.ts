/**
 * Maximum lengths for the free text users type, defined once so the client and
 * the server agree. This mirrors `src/utils/textLimits.ts` in NUCarpool, for
 * the same reason it gives there:
 *
 * Each value is the width of the column the text ends up in. That is the
 * point: these columns are `VARCHAR`, MySQL runs in strict mode, and an
 * oversized value makes the write **throw rather than truncate**. Without a cap
 * matching the column, a pasted essay is accepted by the textarea and by the
 * Zod schema, then rejected by the database after the composer has already
 * cleared the user's text.
 *
 * These count JavaScript string length (UTF-16 code units) while MySQL counts
 * characters, so an emoji costs 2 here and 1 in the column. The comparison
 * therefore errs towards rejecting slightly early, never towards overflowing.
 */

/** `community_post.title` — `VARCHAR(150)`. */
export const POST_TITLE_MAX_LENGTH = 150;

/** `community_post.content` — `VARCHAR(5000)`. */
export const POST_CONTENT_MAX_LENGTH = 5000;

/** `community_comment.content` — `VARCHAR(2000)`. */
export const COMMENT_CONTENT_MAX_LENGTH = 2000;

/**
 * Re-exported from `shared/` so no existing call site changes. The helper is
 * not `content`'s — see `shared/text.ts` — but the limits above are, and
 * callers import both from here.
 */
export { requireBoundedText } from "../../shared/text";
