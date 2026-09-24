import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { useState } from "react";
import { BsThreeDotsVertical } from "react-icons/bs";
import { classNames } from "../../utils/classNames";
import BlockConfirmDialog from "./BlockConfirmDialog";

type UserActionsMenuProps = {
  userId: string;
  /** Names the trigger and the dialog, so both say who this is about. */
  userName: string;
  /**
   * Runs once the block has gone through. A conversation passes its own close
   * handler, because the thread it is showing has just become unavailable.
   */
  onBlocked?: () => void;
  className?: string;
};

/**
 * The overflow menu on another user's card and conversation header
 * (SCRUM-554). It holds Block today. Phase 3 of SCRUM-532 adds Report here.
 *
 * The dialog is rendered beside the `Menu`, not inside an item. A menu closes
 * when an item is chosen, and a dialog inside it would unmount with it.
 *
 * `anchor` portals the items and positions them against the trigger, so a
 * card inside an `overflow-y-auto` list cannot clip the menu.
 */
const UserActionsMenu = ({
  userId,
  userName,
  onBlocked,
  className,
}: UserActionsMenuProps) => {
  const [isConfirming, setIsConfirming] = useState(false);

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
    </>
  );
};

export default UserActionsMenu;
