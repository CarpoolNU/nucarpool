import { useCallback } from "react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import { toastCarpoolEnded } from "./CarpoolEndedToast";

/**
 * Deleting a group and removing a rider from it, owned in one place.
 *
 * These mutations and handlers used to exist twice: once in
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
 * Toasts go through `react-toastify`. The desktop copy used a second toast
 * library for the same three events; that one has since been removed, so
 * `react-toastify` is now the only one.
 *
 * This took the whole driver row as an argument until SCRUM-457, purely to read
 * two fields off it, which made the hook uncallable for a group that has no
 * DRIVER member - the one group whose members most need the removal path, since
 * leaving is all the server will let them do. It now takes the group id and an
 * optional driver id instead.
 */

type UseGroupMembershipArgs = {
  /**
   * The group to act on, taken from the *caller's* own `carpoolId` rather than
   * the driver's.
   *
   * Both name the same group whenever there is a driver, and a group with no
   * DRIVER member has no driver row to read it off at all - which was enough to
   * make this hook uncallable in exactly the state whose only permitted action
   * is the one it exists to perform. See SCRUM-457.
   */
  groupId: string | null;
  /**
   * The group's driver, when it has one.
   *
   * `groups.edit` requires the field but deliberately ignores it on the remove
   * path, deriving the driver from the group's own membership instead - its
   * input schema says so, and crediting the seat to client input is the bug
   * that made it stop. It is still sent when known, so the payload for a group
   * that has a driver is unchanged.
   */
  driverId?: string;
  currentUserId: string;
  /**
   * Called once the caller is no longer part of the group, either because they
   * left it or because the driver dissolved it. The desktop modal uses this to
   * dismiss itself; the mobile page has nothing to dismiss and omits it.
   */
  onLeftGroup?: () => void;
};

export const useGroupMembership = ({
  groupId,
  driverId,
  currentUserId,
  onLeftGroup,
}: UseGroupMembershipArgs) => {
  const utils = trpc.useUtils();

  const { mutate: deleteGroup, isPending: isDeleting } =
    trpc.user.groups.delete.useMutation({
      onError: (error) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      onSuccess: () => {
        utils.user.me.invalidate();
        utils.user.groups.me.invalidate();
        toastCarpoolEnded("Group has been successfully deleted");
        onLeftGroup?.();
      },
    });

  const { mutate: editGroup, isPending: isEditing } =
    trpc.user.groups.edit.useMutation({
      onError: (error) => {
        toast.error(`Something went wrong: ${error.message}`);
      },
      // `variables` carries the riderId that was just removed, which is how we
      // know whether the caller left or merely removed somebody else.
      //
      // `null` data means the server dissolved the group, because one member
      // cannot carpool alone. That leaves the caller without a
      // group whichever side of the removal they were on — so a driver who
      // removes their last rider now gets the modal dismissed too, which the
      // riderId comparison alone would miss.
      onSuccess: (data, variables) => {
        utils.user.me.invalidate();
        utils.user.groups.me.invalidate();

        const callerLeft = variables.riderId === currentUserId;
        const groupDissolved = data === null;

        // Every outcome here ends a pairing the caller was in, so each one
        // carries the feedback prompt. See `CarpoolEndedToast`.
        toastCarpoolEnded(
          callerLeft
            ? "You have left the group"
            : groupDissolved
              ? "Removed from group — with nobody left, the group was disbanded"
              : "Removed from group",
        );

        if (callerLeft || groupDissolved) {
          onLeftGroup?.();
        }
      },
    });

  const handleDeleteGroup = useCallback(() => {
    if (!groupId) {
      toast.error("This group could not be found, so it was not deleted.");
      return;
    }
    deleteGroup({ groupId });
  }, [groupId, deleteGroup]);

  const handleRemoveRider = useCallback(
    (riderId: string) => {
      if (!groupId) {
        toast.error("This group could not be found, so nothing was changed.");
        return;
      }
      editGroup({
        // Ignored by the server on this path, so the caller's own id stands in
        // when the group has no driver to name. See `driverId` above.
        driverId: driverId ?? currentUserId,
        riderId,
        add: false,
        groupId,
      });
    },
    [groupId, driverId, currentUserId, editGroup],
  );

  return {
    handleDeleteGroup,
    handleRemoveRider,
    isMutating: isDeleting || isEditing,
  };
};
