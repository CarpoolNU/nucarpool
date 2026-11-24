import { HandleInvalidError } from "../../shared/errors";

/**
 * Handle parsing and normalization. Pure — no I/O, no database, no clock.
 *
 * A handle has two forms and they do different jobs:
 *
 *   - `display`     what the user typed, casing preserved. Shown on posts.
 *   - `normalized`  lowercased. Carries the uniqueness constraint.
 *
 * **Uniqueness lives on the normalized column, not on `display`.** MySQL's
 * default collation is case-insensitive, so a `@unique` on the display column
 * alone would *appear* to stop `Husky` colliding with `husky`. But that is an
 * implicit property of the column's charset, which a later migration can
 * change without anyone noticing the invariant moved. An explicit column
 * states it and a test can pin it.
 */

export const HANDLE_MIN_LENGTH = 3;

/** Matches the `VarChar(24)` width of both handle columns. */
export const HANDLE_MAX_LENGTH = 24;

/**
 * **ASCII only, deliberately.**
 *
 * Restricting to this set after Unicode normalization is what prevents
 * homoglyph impersonation: Cyrillic `а` (U+0430) and Latin `a` are different
 * code points that NFKC does not fold together, so without this a user could
 * register a handle that renders identically to someone else's. Rejecting
 * non-ASCII outright is blunt, and it is the only defence here that does not
 * require maintaining a confusables table.
 */
const ALLOWED = /^[A-Za-z0-9_]+$/;

/**
 * Handles nobody may claim.
 *
 * These would let a user impersonate the platform or a role. Compared against
 * the normalized form, so `Admin` and `ADMIN` are caught with `admin`.
 */
const RESERVED = new Set([
  "admin",
  "administrator",
  "moderator",
  "mod",
  "staff",
  "official",
  "support",
  "help",
  "system",
  "nucarpool",
  "northeastern",
  "neu",
  "deleted",
  "removed",
  "anonymous",
]);

export type ParsedHandle = {
  display: string;
  normalized: string;
};

/**
 * Validates and normalizes a raw handle, or throws `HandleInvalidError`.
 *
 * Messages name what to fix rather than restating the rule, because this is
 * the first thing a new community member interacts with and a refusal they
 * cannot act on just means they try again blind.
 */
export const parseHandle = (raw: string): ParsedHandle => {
  // NFKC first: it folds fullwidth and other compatibility forms onto their
  // ASCII equivalents, so `ｈｕｓｋｙ` becomes `husky` and is accepted, rather
  // than being rejected as non-ASCII and leaving the user with no idea why.
  const display = raw.normalize("NFKC").trim();

  if (display.length === 0) {
    throw new HandleInvalidError("Enter a handle.");
  }
  if (display.length < HANDLE_MIN_LENGTH) {
    throw new HandleInvalidError(
      `Handles are at least ${HANDLE_MIN_LENGTH} characters.`,
    );
  }
  if (display.length > HANDLE_MAX_LENGTH) {
    throw new HandleInvalidError(
      `Handles are at most ${HANDLE_MAX_LENGTH} characters.`,
    );
  }
  if (!ALLOWED.test(display)) {
    throw new HandleInvalidError(
      "Handles use letters, numbers and underscores only.",
    );
  }
  if (display.startsWith("_") || display.endsWith("_")) {
    throw new HandleInvalidError(
      "Handles can't start or end with an underscore.",
    );
  }

  const normalized = display.toLowerCase();

  if (RESERVED.has(normalized)) {
    throw new HandleInvalidError("That handle is reserved.");
  }

  return { display, normalized };
};
