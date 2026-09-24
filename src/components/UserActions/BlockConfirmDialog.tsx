import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import { invalidateBlockCaches } from "../../utils/blocks/invalidateBlockCaches";

type BlockConfirmDialogProps = {
  open: boolean;
  userId: string;
  userName: string;
  onClose: () => void;
  /** Runs after the block succeeds and the caches are invalidated. */
  onBlocked?: () => void;
};

/**
 * Asks before blocking, and says what a block does (SCRUM-554).
 *
 * The copy promises only what the server does. Both directions are hidden,
 * nothing is deleted, and unblocking from the profile brings it all back. A
 * refusal shows the server's own message. The one a user can meet by
 * ordinary use is "Leave the group first", for someone they carpool with.
 */
const BlockConfirmDialog = ({
  open,
  userId,
  userName,
  onClose,
  onBlocked,
}: BlockConfirmDialogProps) => {
  const utils = trpc.useUtils();

  const { mutate: block, isPending } = trpc.user.blocks.block.useMutation({
    onSuccess: async () => {
      await invalidateBlockCaches(utils);
      toast.success(`You blocked ${userName}.`);
      onClose();
      onBlocked?.();
    },
    onError: (error) => {
      toast.error(error.message);
      onClose();
    },
  });

  return (
    <Dialog open={open} onClose={onClose} className="relative z-50">
      <div className="font-montserrat fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <DialogPanel className="flex w-full max-w-md flex-col rounded-lg bg-white px-6 py-8 text-left shadow-lg">
          <DialogTitle as="h3" className="mb-4 text-xl font-semibold">
            Block {userName}?
          </DialogTitle>
          <p className="mb-2 text-gray-700">
            You won&apos;t see each other in recommendations, on the map, in
            favorites, in requests or in messages, and neither of you can
            contact the other.
          </p>
          <p className="mb-6 text-gray-700">
            Nothing is deleted. You can unblock them from the Account section of
            your profile.
          </p>
          <div className="flex justify-end gap-4">
            <button
              type="button"
              autoFocus
              onClick={onClose}
              className="rounded-md border border-black px-4 py-2 font-medium hover:bg-stone-200"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => block({ userId })}
              className="bg-northeastern-red rounded-md px-4 py-2 font-medium text-white hover:bg-red-700 disabled:bg-gray-300 disabled:hover:bg-gray-300"
            >
              Block
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default BlockConfirmDialog;
