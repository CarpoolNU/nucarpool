import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import {
  GroupDetails,
  StoredGroupPreferences,
  detailsEqual,
  resolveGroupDetails,
  trimDetails,
} from "./groupDetails";

/**
 * The group-details form, owned in one place.
 *
 * This state, the sync effect and the submit path used to be written out four
 * times - once each in `NoGroupInfo`, `MobileNoGroupInfo`, `GroupInfo`
 * and `MobileGroupInfo`.
 *
 * There is also only one thing to write. The old save issued two
 * mutations - `updateMessage` for `group.message` and `updateUserMessage` for
 * `carpool_search.group_message` - carrying the same JSON blob to two columns
 * that could then disagree, and `group.message` was VARCHAR(191) so the group
 * copy could fail while the driver's own copy landed. One self-scoped write
 * replaces both, and `groupId` is no longer needed because the group no longer
 * stores a copy.
 */

type UseGroupDetailsArgs = {
  /**
   * The stored preferences to edit. `undefined` means "not loaded yet", which
   * is what keeps the sync effect from clobbering typing with defaults.
   */
  stored: StoredGroupPreferences | null | undefined;
  /** Only a driver may write; riders read the same value. */
  canEdit: boolean;
};

export const useGroupDetails = ({ stored, canEdit }: UseGroupDetailsArgs) => {
  const utils = trpc.useUtils();
  const [details, setDetails] = useState<GroupDetails>(() =>
    resolveGroupDetails(stored),
  );
  const [isSaving, setIsSaving] = useState(false);

  /*
   * Sync the form from storage, and do it without feeding itself.
   *
   * `stored !== undefined` is the "not loaded yet" guard: `undefined` means the
   * query has not answered and the form must be left alone, while `null` is a
   * real answer - loaded, nothing there - and does reset it. Collapsing the two
   * into `if (stored)` would leave a stale form after the row went away.
   *
   * The `detailsEqual` bail-out is not an optimisation.
   * `resolveGroupDetails` returns a new object every call, so a plain
   * `setDetails(next)` is always a state change and always a render. That is
   * harmless while `stored` keeps its identity - which is why this went
   * unnoticed: both call sites in `GroupPage.tsx` pass React Query data
   * straight through, and structural sharing keeps that reference stable. Give
   * the hook a caller that builds the object instead, and the two take turns
   * forever: effect writes a new details object, caller re-renders, caller
   * builds a new `stored`, `[stored]` changes, effect runs again. React's "too
   * many re-renders" guard does not cover an effect-driven cycle, so there is
   * no error - just a tab climbing memory until it dies.
   *
   * Returning `prev` unchanged stops that at the first repeat, because React
   * bails out of a `useState` update that produces the identical reference.
   *
   * **What this does not change: server data still wins on every sync.** The
   * comparison is between the resolved stored value and whatever the form
   * currently holds, so if the driver has typed, the two differ and the typing
   * is replaced - exactly as before. Only a redundant apply is skipped.
   * Keying the effect on the individual stored values instead would go
   * further, and narrow the window in which a new `stored` reference can
   * discard in-progress typing to one where the stored values genuinely
   * changed. That is a behaviour change rather than a fix, and no reachable
   * path to that clobber has actually been demonstrated - `GroupPage`'s two
   * call sites pass query data, and React Query's structural sharing keeps a
   * sub-object's reference when its contents are unchanged. Left alone
   * deliberately.
   */
  useEffect(() => {
    if (stored === undefined) {
      return;
    }

    const next = resolveGroupDetails(stored);
    setDetails((prev) => (detailsEqual(prev, next) ? prev : next));
  }, [stored]);

  // `mutateAsync`, not `mutate`. The old code did `await mutate(...)` and then
  // fired a success toast - but `mutate` returns void, so the await resolved
  // immediately and the toast appeared whether or not the write landed.
  const { mutateAsync: updatePreferences } =
    trpc.user.groups.updatePreferences.useMutation({
      onSuccess: () => {
        // Both queries carry these values now: `user.me` for the no-group form
        // and `groups.me` for the one riders read.
        utils.user.me.invalidate();
        utils.user.groups.me.invalidate();
      },
    });

  const save = useCallback(
    async ({ successMessage }: { successMessage: string }) => {
      if (!canEdit || isSaving) {
        return;
      }

      // Trimmed, not truncated: the textarea bounds the length, so anything over
      // the limit is a bug that should surface as the server's error rather than
      // be sliced away here.
      const normalized = trimDetails(details);

      setIsSaving(true);
      try {
        await updatePreferences({
          notes: normalized.notes,
          musicPreference: normalized.musicPreference,
          conversationStyle: normalized.conversationStyle,
        });
        toast.success(successMessage);
      } catch (error) {
        toast.error(
          `Could not save your group details: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      } finally {
        setIsSaving(false);
      }
    },
    [canEdit, isSaving, details, updatePreferences],
  );

  return { details, setDetails, save, isSaving };
};
