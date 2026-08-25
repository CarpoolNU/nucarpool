import { Role } from "@prisma/client";
import { PublicUser } from "../../utils/types";
import { useContext, useState } from "react";
import { UserContext } from "../../utils/userContext";
import Spinner from "../Spinner";
import { useGroupMembership } from "./useGroupMembership";

/**
 * The group member list and its rows, once (SCRUM-252).
 *
 * This replaces four components: `GroupMembers` / `GroupMemberCard` here and
 * `MobileGroupMembers` / `MobileMemberCard` in `GroupPage.tsx`. All the mutation
 * wiring moved to `useGroupMembership`; what is left is presentation.
 *
 * The destructive-action confirmation comes from the mobile card. The desktop
 * list had none - "Delete Group" dissolved an entire carpool on a single click
 * with no undo - so this is a deliberate behaviour change on desktop rather than
 * a port of what was there.
 */

interface GroupMembersProps {
  users: PublicUser[];
  /**
   * Called when the caller is no longer in the group. The desktop modal passes
   * its close handler; the mobile page passes nothing.
   */
  onLeftGroup?: () => void;
}

export const GroupMembers = ({ users, onLeftGroup }: GroupMembersProps) => {
  const curUser = useContext(UserContext);
  const driver = users.find((user) => user.role === Role.DRIVER);
  const otherRiders = users.filter(
    (user) => user.id !== driver?.id && user.id !== curUser?.id,
  );

  if (!driver || !curUser) {
    return <Spinner />;
  }

  return (
    <GroupMembersList
      driver={driver}
      curUser={curUser}
      otherRiders={otherRiders}
      onLeftGroup={onLeftGroup}
    />
  );
};

/**
 * Split from `GroupMembers` only so the `driver`/`curUser` null checks happen
 * before `useGroupMembership` is called - a hook cannot sit behind an early
 * return.
 */
const GroupMembersList = ({
  driver,
  curUser,
  otherRiders,
  onLeftGroup,
}: {
  driver: PublicUser;
  curUser: PublicUser;
  otherRiders: PublicUser[];
  onLeftGroup?: () => void;
}) => {
  const { handleDeleteGroup, handleRemoveRider, isMutating } =
    useGroupMembership({
      driver,
      currentUserId: curUser.id,
      onLeftGroup,
    });

  const isDriver = curUser.role === Role.DRIVER;

  return (
    <>
      <GroupMemberCard
        user={driver}
        isCurrentUser={driver.id === curUser.id}
        actionLabel={isDriver ? "Delete Group" : undefined}
        onAction={isDriver ? handleDeleteGroup : undefined}
        confirmPrompt="Delete this group for everyone?"
        disabled={isMutating}
      />

      {!isDriver && (
        <GroupMemberCard
          user={curUser}
          isCurrentUser
          actionLabel="Leave Group"
          onAction={() => handleRemoveRider(curUser.id)}
          confirmPrompt="Leave this group?"
          disabled={isMutating}
        />
      )}

      {otherRiders.map((rider) => (
        <GroupMemberCard
          key={rider.id}
          user={rider}
          isCurrentUser={false}
          actionLabel={isDriver ? "Remove" : undefined}
          onAction={isDriver ? () => handleRemoveRider(rider.id) : undefined}
          confirmPrompt={`Remove ${rider.preferredName} from the group?`}
          disabled={isMutating}
        />
      ))}
    </>
  );
};

interface GroupMemberCardProps {
  user: PublicUser;
  isCurrentUser: boolean;
  actionLabel?: string;
  onAction?: () => void;
  confirmPrompt: string;
  disabled?: boolean;
}

export const GroupMemberCard = ({
  user,
  isCurrentUser,
  actionLabel,
  onAction,
  confirmPrompt,
  disabled = false,
}: GroupMemberCardProps) => {
  const [isConfirming, setIsConfirming] = useState(false);

  return (
    <div className="flex items-center gap-3 px-2 py-3 sm:px-4">
      {/* Avatar */}
      <div className="flex-shrink-0">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-200">
          <span className="text-lg font-medium text-gray-600">
            {user.preferredName.charAt(0).toUpperCase()}
          </span>
        </div>
      </div>

      {/* Identity */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-base font-semibold text-gray-900">
            {user.preferredName}
            {isCurrentUser && (
              <span className="ml-1 text-sm font-normal text-gray-500">
                (You)
              </span>
            )}
          </h3>
          <span
            className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
              user.role === Role.DRIVER
                ? "bg-blue-100 text-blue-800"
                : "bg-green-100 text-green-800"
            }`}
          >
            {user.role === Role.DRIVER ? "Driver" : "Rider"}
          </span>
        </div>
        <p className="truncate text-sm text-gray-600">{user.email}</p>
      </div>

      {/* Action */}
      {actionLabel && onAction && (
        <div className="flex-shrink-0">
          {isConfirming ? (
            <div className="flex flex-col items-end gap-1">
              <p className="text-xs text-gray-600">{confirmPrompt}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onAction();
                    setIsConfirming(false);
                  }}
                  className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setIsConfirming(false)}
                  className="rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => setIsConfirming(true)}
              className="rounded-lg bg-red-100 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-200 disabled:opacity-50"
            >
              {actionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
