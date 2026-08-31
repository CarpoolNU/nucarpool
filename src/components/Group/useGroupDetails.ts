import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { trpc } from "../../utils/trpc";
import {
  GroupDetails,
  StoredGroupPreferences,
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

  useEffect(() => {
    if (stored !== undefined) {
      setDetails(resolveGroupDetails(stored));
    }
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
