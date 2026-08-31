/**
 * Maximum lengths for the free text users type, defined once so the client and
 * the server agree (SCRUM-231).
 *
 * Each value is the width of the column the text ends up in. That is the point:
 * these columns are `VARCHAR`, MySQL runs in strict mode, and an oversized
 * value makes the write throw rather than truncate. Before this existed the
 * chat box had no cap at all, so a pasted paragraph was accepted by the input,
 * accepted by the Zod schema, and then rejected by the database after the box
 * had already been cleared.
 *
 * These count JavaScript string length (UTF-16 code units) while MySQL counts
 * characters, so an astral character such as an emoji costs 2 here and 1 in the
 * column. The comparison therefore errs towards rejecting slightly early, never
 * towards overflowing.
 *
 * See "Text lengths" in `src/server/db/README.md` for the full column list.
 */

/**
 * `message.content` — `VARCHAR(255)`.
 *
 * Covers both chat messages and the opening message on a carpool request:
 * `requests.create` writes its `message` input to a `Message` row, not to
 * `request.message`.
 */
export const MESSAGE_MAX_LENGTH = 255;

/**
 * `user.bio`, `user.preferred_name`, `user.pronouns` and
 * `carpool_search.company_name` — all `VARCHAR(191)`, Prisma's default width
 * for an unannotated `String` on MySQL.
 *
 * A ceiling, not a design: the name fields are held to 20 in the UI because
 * that is what the layout wants. This is the length past which a save fails.
 */
export const PROFILE_TEXT_MAX_LENGTH = 191;

/**
 * `carpool_search.group_notes` — `VARCHAR(90)`.
 *
 * The driver's free-text note on their group ride preferences. 90 is what the
 * textarea has always allowed and what the column is now sized to (SCRUM-253);
 * before that the value went into a shared JSON blob and was silently sliced to
 * this length on the way in, whatever the user had typed.
 */
export const GROUP_NOTES_MAX_LENGTH = 90;

/**
 * `carpool_search.group_music_preference` and
 * `carpool_search.group_conversation_style` — both `VARCHAR(40)`.
 *
 * These are fixed-choice fields; every option the UI offers is far shorter. The
 * width exists so a value that is not one of the options still cannot overflow
 * the column.
 */
export const GROUP_OPTION_MAX_LENGTH = 40;
