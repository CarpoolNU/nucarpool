/**
 * Whether an in-progress edit can be submitted, and if not, why.
 *
 * **It mirrors the server's own rule rather than inventing a client one.**
 * `requireBoundedText` trims, refuses empty, then refuses over-long; this
 * trims and measures the same way, so the button goes dead on exactly the
 * drafts the service would refuse. A looser client would clear a composer and
 * hand back a `BAD_REQUEST`; a stricter one would refuse text the server would
 * have taken.
 *
 * **"Unchanged" is this module's own rule and has no server counterpart.** An
 * edit that writes the identical row is not an error — the service would take
 * it happily — but it would spend a `CONTENT_EDIT` charge and stamp `editedAt`,
 * which puts an "edited" marker on a post nobody edited. Refusing it here is
 * cheaper and more honest than a no-op write.
 *
 * Lives apart from the components that use it because Jest matches `.ts` only,
 * and this is the part of an edit form worth pinning.
 */

export type DraftField = {
  /** What is in the input now. */
  value: string;
  /** What is stored, as the server last returned it — already trimmed. */
  original: string;
  /** The column's width, from `content/domain/textLimits`. */
  max: number;
};

export type DraftBlock = "empty" | "too-long" | "unchanged";

export type DraftState = {
  canSubmit: boolean;
  /** `null` exactly when {@link DraftState.canSubmit} is true. */
  blockedBy: DraftBlock | null;
};

/**
 * **Order matters and is pinned by the tests beside this file**: empty, then
 * too long, then unchanged. Emptiness comes first because it is the fault the
 * person has just caused and can undo; "unchanged" comes last because it is the
 * only one that is not a fault at all.
 */
export const editDraftState = (fields: readonly DraftField[]): DraftState => {
  const trimmed = fields.map((f) => ({ ...f, trimmedValue: f.value.trim() }));

  if (trimmed.some((f) => f.trimmedValue.length === 0)) {
    return { canSubmit: false, blockedBy: "empty" };
  }
  if (trimmed.some((f) => f.trimmedValue.length > f.max)) {
    return { canSubmit: false, blockedBy: "too-long" };
  }
  if (trimmed.every((f) => f.trimmedValue === f.original.trim())) {
    return { canSubmit: false, blockedBy: "unchanged" };
  }

  return { canSubmit: true, blockedBy: null };
};
