import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { ReportReason } from "@prisma/client";
import { useState } from "react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import { invalidateBlockCaches } from "../../utils/blocks/invalidateBlockCaches";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../utils/textLimits";
import {
  REPORT_REASONS,
  REPORT_REASON_LABELS,
  REPORT_SNAPSHOT_MESSAGE_LIMIT,
} from "../../utils/reports";

type ReportDialogProps = {
  userId: string;
  userName: string;
  /**
   * The conversation this was opened from, if any. The server then keeps a
   * copy of its recent messages with the report.
   */
  requestId?: string;
  onClose: () => void;
  /** Runs when "Also block" went through, after the caches are invalidated. */
  onBlocked?: () => void;
};

/**
 * Reports another user to the admins (SCRUM-555).
 *
 * `UserActionsMenu` mounts this only while it is open, so the form starts
 * empty each time and nothing typed in one report carries into the next.
 *
 * "Also block" is on by default, because someone reporting a person usually
 * does not want to hear from them again. When the block is refused, which
 * happens for someone in the reporter's own group, the report has still been
 * saved, and the refusal is shown as a note rather than an error.
 *
 * An error keeps the dialog open, unlike `BlockConfirmDialog`, so a failed
 * submit does not throw away what the reporter wrote.
 */
const ReportDialog = ({
  userId,
  userName,
  requestId,
  onClose,
  onBlocked,
}: ReportDialogProps) => {
  const utils = trpc.useUtils();
  const [reason, setReason] = useState<ReportReason | "">("");
  const [message, setMessage] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(true);

  const { mutate: report, isPending } = trpc.user.reports.create.useMutation({
    onSuccess: async (result) => {
      if (result.blocked) {
        await invalidateBlockCaches(utils);
      }
      toast.success(
        result.blocked
          ? `Thanks. We've received your report, and you blocked ${userName}.`
          : "Thanks. We've received your report.",
      );
      if (result.blockRefusal) {
        toast.info(result.blockRefusal);
      }
      onClose();
      if (result.blocked) {
        onBlocked?.();
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!reason) return;
    report({
      reportedUserId: userId,
      reason,
      message: message.trim() || undefined,
      requestId,
      alsoBlock,
    });
  };

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <div className="font-montserrat fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <DialogPanel className="flex w-full max-w-md flex-col rounded-lg bg-white px-6 py-8 text-left shadow-lg">
          <DialogTitle as="h3" className="mb-4 text-xl font-semibold">
            Report {userName}
          </DialogTitle>
          <form onSubmit={submit} className="flex flex-col">
            <label htmlFor="report-reason" className="mb-1 font-medium">
              Reason
            </label>
            <select
              id="report-reason"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value as ReportReason | "")}
              className="mb-4 rounded-md border border-stone-400 px-3 py-2"
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {REPORT_REASONS.map((value) => (
                <option key={value} value={value}>
                  {REPORT_REASON_LABELS[value]}
                </option>
              ))}
            </select>
            <label htmlFor="report-message" className="mb-1 font-medium">
              What happened? (optional)
            </label>
            <textarea
              id="report-message"
              value={message}
              maxLength={REPORT_MESSAGE_MAX_LENGTH}
              onChange={(e) => setMessage(e.target.value)}
              className="form-input flex max-h-32 min-h-16 w-full rounded-lg border border-stone-400 px-3 py-2"
            />
            <div className="mb-4 text-end text-sm text-stone-600">
              {message.length}/{REPORT_MESSAGE_MAX_LENGTH}
            </div>
            {requestId && (
              <p className="mb-4 text-sm text-gray-700">
                The last {REPORT_SNAPSHOT_MESSAGE_LIMIT} messages in this
                conversation will be included for the admins to review.
              </p>
            )}
            <label className="mb-6 flex items-center gap-2">
              <input
                type="checkbox"
                checked={alsoBlock}
                onChange={(e) => setAlsoBlock(e.target.checked)}
                className="h-4 w-4"
              />
              Also block {userName}
            </label>
            <div className="flex justify-end gap-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-black px-4 py-2 font-medium hover:bg-stone-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending || !reason}
                className="bg-northeastern-red rounded-md px-4 py-2 font-medium text-white hover:bg-red-700 disabled:bg-gray-300 disabled:hover:bg-gray-300"
              >
                Report
              </button>
            </div>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default ReportDialog;
