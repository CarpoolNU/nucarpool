import { TextEmptyError, TextTooLongError } from "./errors";

/**
 * Bounding rules for user-typed text.
 *
 * **This lives in `shared/` because the helper is not `content`'s.** It began
 * beside the post and comment limits, but `moderation` bounds a report message
 * and a review note with exactly the same rule: trim, refuse empty, refuse
 * over-long. A second copy in `moderation` would be a second answer to one
 * question, and the two would drift the first time somebody tightened one — a
 * report message would then be trimmed differently from the post it complains
 * about. The per-field maximums stay with the module that owns the column.
 */

/**
 * Trims and bounds a user-typed field, or throws.
 *
 * **Trimming happens before the emptiness check**, so a title of three spaces
 * is refused rather than stored as a blank that renders as an untitled post.
 */
export const requireBoundedText = (
  label: string,
  raw: string,
  maxLength: number,
): string => {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new TextEmptyError(`${label} can't be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new TextTooLongError(
      `${label} is too long — ${maxLength} characters at most.`,
    );
  }

  return trimmed;
};
