import { useCallback } from "react";
import { toast } from "react-toastify";
import { trpc } from "../../utils/trpc";
import { PublicUser } from "../../utils/types";

/**
 * Deleting a group and removing a rider from it, owned in one place.
 *
 * Before SCRUM-252 these mutations and handlers existed twice: once in
 * `GroupMembers` (desktop) and once in `MobileGroupMembers`. The two had already
 * drifted in three ways, all resolved here:
 *
 *  1. `MobileGroupMembers` carried an empty `if (riders.length <= 1) {}` branch
 *     where the desktop copy closed the modal - so on mobile that path skipped
 *     `groups.me` invalidation entirely and the member list went stale after a
 *     removal.
 *  2. The desktop condition was itself wrong. `riders.length <= 1` counts the
 *     *other* riders, which says nothing about whether the caller is still in
 *     the group: a rider leaving a group with two other riders stayed on a page
 *     for a group they had just left, while a driver removing one rider from a
 *     two-person group had the modal shut on them. The rule is now "leave the
 *     view when the caller is the one who left", which is what both cases
 *     actually wanted.
 *  3. Desktop threw a `TRPCClientError` from inside a click handler when
 *     `carpoolId` was missing (unhandled, no feedback); mobile silently did
 *     nothing. Both now surface an error toast.
 *
 * Toasts go through `react-toastify`. The desktop copy used `react-toast-
 * notifications` for the same three events, which is the older of the two
 * libraries in this repo and the less used.
 */

type UseGroupMembershipArgs = {
  driver: PublicUser;
  currentUserId: string;
  /**
   * Called once the caller is no longer part of the group, either because they
   * left it or because the driver dissolved it. The desktop modal uses this to
   * dismiss itself; the mobile page has nothing to dismiss and omits it.
   */
  onLeftGroup?: () => void;
};

export const useGroupMembership = ({
  driver,
  currentUserId,
  onLeftGroup,
}: UseGroupMembershipArgs) => {
  const utils = trpc.useUtils();

  const { mutate: deleteGroup, isLoading: isDeleting } =
    trpc.user.groups.delete.useMutation({
      onError: (error) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      onSuccess: () => {
        utils.user.me.invalidate();
        utils.user.groups.me.invalidate();
        toast.success("Group has been successfully deleted");
        onLeftGroup?.();
      },
    });

  const { mutate: editGroup, isLoading: isEditing } =
    trpc.user.groups.edit.useMutation({
      onError: (error) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      // `variables` carries the riderId that was just removed, which is how we
      // know whether the caller left or merely removed somebody else.
      onSuccess: (_data, variables) => {
        utils.user.me.invalidate();
        utils.user.groups.me.invalidate();
        toast.success(
          variables.riderId === currentUserId
            ? "You have left the group"
            : "Removed from group",
        );
        if (variables.riderId === currentUserId) {
          onLeftGroup?.();
        }
      },
    });

  const handleDeleteGroup = useCallback(() => {
    if (!driver.carpoolId) {
      toast.error("This group could not be found, so it was not deleted.");
      return;
    }
    deleteGroup({ groupId: driver.carpoolId });
  }, [driver.carpoolId, deleteGroup]);

  const handleRemoveRider = useCallback(
    (riderId: string) => {
      if (!driver.carpoolId) {
        toast.error("This group could not be found, so nothing was changed.");
        return;
      }
      editGroup({
        driverId: driver.id,
        riderId,
        add: false,
        groupId: driver.carpoolId,
      });
    },
    [driver.carpoolId, driver.id, editGroup],
  );

  return {
    handleDeleteGroup,
    handleRemoveRider,
    isMutating: isDeleting || isEditing,
  };
};
