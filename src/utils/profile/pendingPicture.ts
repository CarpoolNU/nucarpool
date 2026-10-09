/**
 * The profile picture change a user has made but not yet saved.
 *
 * Uploading and removing are mutually exclusive — a user cannot be saving a new
 * crop *and* deleting their picture — so they share one slot rather than
 * sitting in a `File | null` beside a `boolean`. Two pieces of state would make
 * the exclusion something every handler has to remember, and a handler that
 * forgot would leave a pending crop and a pending removal both set, with the
 * save path's branch order silently deciding which one won. One slot makes it
 * true by construction instead.
 *
 * `ProfilePicture` derives its preview from this for the same reason it already
 * derived the preview from the file: a single source of truth cannot disagree
 * with itself across a remount.
 *
 * Note that **`"remove"` means "delete the stored picture", not "discard the
 * pending crop"**. Discarding a crop when nothing is stored returns the user to
 * the state they started in, which is `null` — no unsaved change, and no
 * removal mutation on save. `ProfilePicture` is where that distinction is made,
 * because it is the only party that knows whether a stored picture exists.
 */

/** The marker for a pending deletion of the stored picture. */
export const PENDING_REMOVAL = "remove" as const;

export type PendingPicture = File | typeof PENDING_REMOVAL | null;

/**
 * The cropped file waiting to be uploaded, or null when none is.
 *
 * Narrows by `instanceof` rather than by excluding the string literal so that
 * the result is a `File` to TypeScript as well as at runtime, which is what
 * lets `useUploadFile` keep its existing `File | null` parameter untouched.
 */
export const pendingPictureFile = (pending: PendingPicture): File | null =>
  pending instanceof File ? pending : null;

/** Whether the stored picture is marked for deletion on the next save. */
export const isPendingRemoval = (
  pending: PendingPicture,
): pending is typeof PENDING_REMOVAL => pending === PENDING_REMOVAL;
