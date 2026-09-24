import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { useState } from "react";
import { BsThreeDotsVertical } from "react-icons/bs";
import { classNames } from "../../utils/classNames";
import BlockConfirmDialog from "./BlockConfirmDialog";
import ReportDialog from "./ReportDialog";

type UserActionsMenuProps = {
  userId: string;
  /** Names the trigger and the dialog, so both say who this is about. */
  userName: string;
  /**
   * The conversation this menu sits on, if any. A report made from here keeps
   * a copy of its recent messages.
   */
  requestId?: string;
  /**
   * Runs once a block has gone through, from Block or from a report's "Also
   * block". A conversation passes its own close handler, because the thread
   * it is showing has just become unavailable.
   */
  onBlocked?: () => void;
  className?: string;
};

/**
 * The overflow menu on another user's card and conversation header
 * (SCRUM-554). It holds Report (SCRUM-555) and Block.
 *
 * The dialogs are rendered beside the `Menu`, not inside an item. A menu
 * closes when an item is chosen, and a dialog inside it would unmount with it.
 *
 * `ReportDialog` is mounted only while open, so its form starts empty every
 * time. `BlockConfirmDialog` has no form to reset and stays mounted.
 *
 * `anchor` portals the items and positions them against the trigger, so a
 * card inside an `overflow-y-auto` list cannot clip the menu.
 */
const UserActionsMenu = ({
  userId,
  userName,
  requestId,
  onBlocked,
  className,
}: UserActionsMenuProps) => {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isReporting, setIsReporting] = useState(false);

  return (
    <>
      <Menu>
        <MenuButton
          aria-label={`More actions for ${userName}`}
          className={classNames(
            "flex h-11 w-11 items-center justify-center rounded-full text-gray-700 hover:bg-stone-200",
            className,
          )}
        >
          <BsThreeDotsVertical className="h-5 w-5" aria-hidden="true" />
        </MenuButton>
        <MenuItems
          anchor="bottom end"
          className="font-montserrat z-40 w-44 rounded-lg bg-white py-1 shadow-lg ring-1 ring-black/5 focus:outline-hidden"
        >
          <MenuItem>
            <button
              type="button"
              onClick={() => setIsReporting(true)}
              className="w-full px-4 py-2 text-left text-sm font-medium text-gray-900 data-[focus]:bg-stone-100"
            >
              Report
            </button>
          </MenuItem>
          <MenuItem>
            <button
              type="button"
              onClick={() => setIsConfirming(true)}
              className="text-northeastern-red w-full px-4 py-2 text-left text-sm font-medium data-[focus]:bg-stone-100"
            >
              Block
            </button>
          </MenuItem>
        </MenuItems>
      </Menu>
      <BlockConfirmDialog
        open={isConfirming}
        userId={userId}
        userName={userName}
        onClose={() => setIsConfirming(false)}
        onBlocked={onBlocked}
      />
      {isReporting && (
        <ReportDialog
          userId={userId}
          userName={userName}
          requestId={requestId}
          onClose={() => setIsReporting(false)}
          onBlocked={onBlocked}
        />
      )}
    </>
  );
};

export default UserActionsMenu;
