import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { trpc } from "../../utils/trpc";
import {
  GroupDetails,
  parseGroupDetails,
  serializeGroupDetails,
} from "./groupDetails";

/**
 * The group-details form, owned in one place.
 *
 * Before SCRUM-252 this state, the sync effect and the submit path were written
 * out four times - once each in `NoGroupInfo`, `MobileNoGroupInfo`, `GroupInfo`
 * and `MobileGroupInfo`. The mobile and desktop copies agreed; the no-group and
 * has-group copies legitimately differ, because with no group there is no group
 * id to write to. That difference is now the `groupId` argument rather than four
 * separate components.
 */

type UseGroupDetailsArgs = {
  /** The stored value to edit. `undefined` means "not loaded yet". */
  message: string | null | undefined;
  /**
   * The group to write to, when the driver has one. Absent means only the
   * caller's own `CarpoolSearch.groupMessage` is written - there is no group
   * row yet, so there is nothing else to write to.
   */
  groupId?: string;
  /** Only a driver may write; riders read the same value. */
  canEdit: boolean;
};

export const useGroupDetails = ({
  message,
  groupId,
  canEdit,
}: UseGroupDetailsArgs) => {
  const utils = trpc.useUtils();
  const [details, setDetails] = useState<GroupDetails>(() =>
    parseGroupDetails(message),
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (message !== undefined) {
      setDetails(parseGroupDetails(message ?? ""));
    }
  }, [message]);

  // `mutateAsync`, not `mutate`. The old code did `await mutate(...)` and then
  // fired a success toast - but `mutate` returns void, so the await resolved
  // immediately and the toast appeared whether or not the write landed. Neither
  // mutation declared an onError either, so a rejected save was silent. That
  // matters here because `group.message` is VARCHAR(191) and the encoded blob
  // can exceed it (SCRUM-253): the driver was told "saved" while riders kept
  // seeing the old details. Awaiting the real promise makes the failure visible;
  // stopping it from happening is SCRUM-253.
  const { mutateAsync: updateGroupMessage } =
    trpc.user.groups.updateMessage.useMutation({
      onSuccess: () => utils.user.groups.me.invalidate(),
    });

  const { mutateAsync: updateOwnMessage } =
    trpc.user.groups.updateUserMessage.useMutation({
      onSuccess: () => utils.user.me.invalidate(),
    });

  const save = useCallback(
    async ({ successMessage }: { successMessage: string }) => {
      if (!canEdit || isSaving) {
        return;
      }

      const serialized = serializeGroupDetails(details);
      setIsSaving(true);
      try {
        // The group row is the copy riders read, so it goes first: if it fails
        // the driver's own copy is left alone rather than silently diverging.
        if (groupId) {
          await updateGroupMessage({ groupId, message: serialized });
        }
        await updateOwnMessage({ message: serialized });
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
    [canEdit, isSaving, details, groupId, updateGroupMessage, updateOwnMessage],
  );

  return { details, setDetails, save, isSaving };
};
