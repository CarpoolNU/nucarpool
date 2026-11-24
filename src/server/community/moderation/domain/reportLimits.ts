/**
 * Maximum lengths for the free text a report carries, defined once so the
 * client and the server agree. The reasoning is `content`'s `textLimits.ts`
 * verbatim: each value is the width of the column the text ends up in, MySQL
 * runs in strict mode, and an oversized value makes the write **throw rather
 * than truncate** — after the reporter's dialog has already closed.
 *
 * These count UTF-16 code units while MySQL counts characters, so the
 * comparison errs towards rejecting slightly early, never towards overflowing.
 */

/** `community_report.message` — `VARCHAR(500)`. */
export const REPORT_MESSAGE_MAX_LENGTH = 500;

/** `community_report.review_note` — `VARCHAR(500)`. */
export const REVIEW_NOTE_MAX_LENGTH = 500;
