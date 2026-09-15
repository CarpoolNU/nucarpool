import { Role } from "@prisma/client";
import { PublicUser } from "../../utils/types";
import { useContext, useState } from "react";
import { UserContext } from "../../utils/userContext";
import Spinner from "../Spinner";
import { useGroupMembership } from "./useGroupMembership";

/**
 * The group member list and its rows, once.
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

  /*
   * The spinner belongs to this condition and this one only. `UserContext` is
   * null until `user.me` resolves, and no row below can be drawn - not even
   * the caller's own - without the caller.
   *
   * A missing *driver* used to share this branch, and that was the bug. The
   * group query has already succeeded by then; the group simply has no DRIVER
   * member, and nothing about that will change on its own - so the spinner was
   * permanent, and the member list, the explanation and the one exit the server
   * still accepts were all unreachable behind it. 15 groups holding 33 members
   * were in that state on production. See SCRUM-457.
   */
  if (!curUser) {
    return <Spinner />;
  }

  return (
    <GroupMembersList
      users={users}
      curUser={curUser}
      onLeftGroup={onLeftGroup}
    />
  );
};

/**
 * Split from `GroupMembers` only so the `curUser` null check happens before
 * `useGroupMembership` is called - a hook cannot sit behind an early return.
 *
 * The driver is resolved here rather than above for the same reason it is no
 * longer a precondition: it decides what to *draw*, not whether to draw.
 */
const GroupMembersList = ({
  users,
  curUser,
  onLeftGroup,
}: {
  users: PublicUser[];
  curUser: PublicUser;
  onLeftGroup?: () => void;
}) => {
  const driver = users.find((user) => user.role === Role.DRIVER);
  const otherMembers = users.filter(
    (user) => user.id !== driver?.id && user.id !== curUser.id,
  );

  const { handleDeleteGroup, handleRemoveRider, isMutating } =
    useGroupMembership({
      groupId: curUser.carpoolId,
      driverId: driver?.id,
      currentUserId: curUser.id,
      onLeftGroup,
    });

  /*
   * Managing a group means acting on somebody else's membership, and
   * `requireGroupDriver` refuses that for every caller once the group has no
   * DRIVER member. So "Delete Group" and "Remove" are withheld here rather
   * than drawn and then rejected by the server.
   *
   * `curUser.role === DRIVER` on its own would very nearly do, since a driver
   * of *this* group would be among `users` and therefore found above - but the
   * condition that actually governs the server's answer is the group's state,
   * so that is the one written down.
   */
  const canManage = driver !== undefined && curUser.role === Role.DRIVER;

  /*
   * The caller's own row. Offered to every member who is not managing the
   * group, which now includes every member of a driverless one: `groups.edit`
   * skips the seat credit instead of failing it precisely so that leaving
   * stays possible there.
   */
  const leaveCard = (
    <GroupMemberCard
      user={curUser}
      isCurrentUser
      actionLabel="Leave Group"
      onAction={() => handleRemoveRider(curUser.id)}
      confirmPrompt="Leave this group?"
      disabled={isMutating}
    />
  );

  const otherMemberCards = otherMembers.map((member) => (
    <GroupMemberCard
      key={member.id}
      user={member}
      isCurrentUser={false}
      actionLabel={canManage ? "Remove" : undefined}
      onAction={canManage ? () => handleRemoveRider(member.id) : undefined}
      confirmPrompt={`Remove ${member.preferredName} from the group?`}
      disabled={isMutating}
    />
  ));

  if (!driver) {
    return (
      <>
        <DriverlessGroupNotice memberCount={users.length} />
        {leaveCard}
        {otherMemberCards}
      </>
    );
  }

  return (
    <>
      <GroupMemberCard
        user={driver}
        isCurrentUser={driver.id === curUser.id}
        actionLabel={canManage ? "Delete Group" : undefined}
        onAction={canManage ? handleDeleteGroup : undefined}
        confirmPrompt="Delete this group for everyone?"
        disabled={isMutating}
      />

      {!canManage && leaveCard}

      {otherMemberCards}
    </>
  );
};

/**
 * What a group with no driver says for itself, in place of the spinner it used
 * to show instead.
 *
 * Two facts, because each one is load-bearing for the person reading it:
 *
 *  1. Nothing here can be managed. `requireGroupDriver` refuses every
 *     management action in this state, so the screen is not merely missing
 *     buttons - the actions do not exist to offer.
 *  2. Leaving may end the group. `groups.edit` dissolves a group once a single
 *     member would be left, and 14 of the 15 driverless groups on production
 *     hold exactly two members - so for almost all of them, one person leaving
 *     is the end of it. Said here, before the confirmation, rather than in a
 *     toast afterwards.
 *
 * "Members" throughout, never "riders": 8 of the 33 people in this state are
 * VIEWER rows.
 */
const DriverlessGroupNotice = ({ memberCount }: { memberCount: number }) => (
  <div className="bg-gray-50 px-2 py-3 sm:px-4">
    <h3 className="text-base font-semibold text-gray-900">
      This group has no driver
    </h3>
    <p className="mt-1 text-sm text-gray-600">
      Nobody in this group is signed up to drive, so there is nothing to manage
      here and no route to preview. Leaving the group is the only change you can
      make.
      {memberCount === 2
        ? " There are only two of you, so leaving will dissolve the group for both of you."
        : ""}
    </p>
  </div>
);

/**
 * Role badges, one per role.
 *
 * VIEWER used to fall into the `: "Rider"` half of a two-way conditional and be
 * labelled as something it is not - and a group member can genuinely be one,
 * since `carpoolId` lives on `CarpoolSearch` alongside `role` and nothing ties
 * the two together. 8 of the 33 members of the driverless groups on production
 * are VIEWER rows, every one of them previously shown as "Rider".
 */
const ROLE_BADGES: Record<Role, { label: string; className: string }> = {
  [Role.DRIVER]: { label: "Driver", className: "bg-blue-100 text-blue-800" },
  [Role.RIDER]: { label: "Rider", className: "bg-green-100 text-green-800" },
  [Role.VIEWER]: { label: "Viewer", className: "bg-gray-200 text-gray-700" },
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
  const roleBadge = ROLE_BADGES[user.role];

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
            className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${roleBadge.className}`}
          >
            {roleBadge.label}
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
              {/*
                A column, Cancel on top, and both of those are measurements
                rather than taste.

                The pair used to be a row 8px apart, 36px tall, with Confirm
                leftmost. Two things were wrong with that and only one of them
                is the one you would guess.

                `p-3` is the 44px: 12 + 20 (the `text-sm` line box) + 12 = 44,
                the figure Apple's HIG and WCAG 2.5.5 ask of a touch control
                and the one the explore sheet handle and the conversation back
                control already meet. The padding is the tap target - do not
                trade it away to make the labels look smaller.

                The column is the more interesting half. `RequestControls` in
                `MessageHeader` puts Cancel first for exactly this hazard, and
                copying that ordering into a row here would have made this
                *worse*, because the two components align their controls
                oppositely. There the pair are `flex-1` across a full-width
                row, so "first" means leftmost and Reject was leftmost too.
                Here the pair are right-aligned under `items-end`, beneath a
                trigger that is right-aligned in this same shrink-wrapped
                slot - so "first" means *furthest from* the button the finger
                just pressed, and last means on top of it.

                Measured in Chromium at 375px against this project's own
                compiled stylesheet, as the share of the trigger's own
                footprint that the affirmative button comes to occupy:

                                        Delete Group  Leave Group  Remove
                  a row, Confirm first     18.6%        16.5%        0%
                  a row, Cancel first      42.2%        44.2%      60.7%
                  a column, Cancel first      0%           0%         0%

                So the row it had was already safer at the centre than the
                reordered row would be - a press at the trigger's midpoint
                lands on Cancel in the first case and on Confirm in the
                second. What the old row really exposed was its left third,
                43px of which sat outside the trigger's footprint entirely.

                A column removes the question instead of trading one edge for
                another: Confirm ends up below the trigger's bottom edge, with
                no vertical overlap at any label, so no press anywhere inside
                the box the user just pressed can reach it.

                `gap-6` - 24px - is then about the remaining hazard, which is
                a press aimed at Cancel drifting down onto Confirm rather than
                a repeat press. 24px is the figure SCRUM-468 settled on for a
                destructive control next to a non-destructive one, reused so
                there is one number in the codebase for this rather than two.

                The colours are deliberately *not* SCRUM-468's. That ticket
                gave Cancel the filled treatment because `primary` in the
                conversation header is `northeastern-red`, the brand colour
                Accept wears, so a filled red Confirm impersonated the
                constructive button. `bg-red-600` here is a plain danger red
                that nothing constructive uses, so the argument does not carry
                and filled-red-means-destructive is left alone.

                jsdom measures none of this - see `testing/viewport.ts`.
                `GroupMemberCard.test.tsx` asserts tree order and the wiring,
                which are the parts that are assertable there, and says so.
              */}
              <div className="flex flex-col gap-6">
                <button
                  type="button"
                  onClick={() => setIsConfirming(false)}
                  className="rounded-lg bg-gray-100 p-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onAction();
                    setIsConfirming(false);
                  }}
                  className="rounded-lg bg-red-600 p-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            </div>
          ) : (
            /*
              `p-3`, not `px-3 py-2`, and the vertical half is the point: 12 +
              20 (the `text-sm` line box) + 12 = 44, the same figure the pair
              behind this button already meets. It was 36px - 8 + 20 + 8 - so
              the flow got *easier* to hit as it got more dangerous, which is
              backwards. The horizontal padding is unchanged at 12px, so the
              trigger's width does not move and the name beside it clips no
              further than it did.

              The row does not grow. Its content box is 48px, set by the
              `h-12` avatar, and a 44px button still fits inside that - the
              72px is the avatar's and stays the avatar's. Measured, not
              assumed; the 73px an inspector shows on a non-last row is
              `divide-y`'s 1px border on the container, not this card.

              SCRUM-476's property survives too: Confirm sits 46px below this
              button's bottom edge before the change and 42px after it, still
              0% of the footprint. See SCRUM-480.
            */
            <button
              type="button"
              disabled={disabled}
              onClick={() => setIsConfirming(true)}
              className="rounded-lg bg-red-100 p-3 text-sm font-medium text-red-700 transition-colors hover:bg-red-200 disabled:opacity-50"
            >
              {actionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
