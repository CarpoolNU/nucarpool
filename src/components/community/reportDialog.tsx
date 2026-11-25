/**
 * The report control.
 *
 * **The acknowledgement is the same words every time.** The server returns a
 * bare `{ acknowledged: true }` and nothing else, and this is the half that
 * must not undo it: a message that varied with the outcome — "thanks, we've
 * removed it", "already reviewed", nothing at all for a second report — would
 * tell the reporter whether their report was acted on, and in a community this
 * small that is enough to work out who reported whom. So success is one fixed
 * sentence, and nothing on this component reads what happened to the content.
 *
 * **A refusal is a different thing and is shown.** `TOO_MANY_REQUESTS` (the
 * `REPORT_CREATE` budget) and `NOT_FOUND` (content the reporter cannot see) are
 * a report that was *not* filed, and a reporter who believed otherwise would
 * not try again. Both go through `ErrorNote` inside the dialog, as in
 * `SaveButton`. **The dialog cannot be dismissed while the request is in
 * flight** — Cancel, Escape and the backdrop are all held — because closing
 * mid-request would drop a late refusal and leave the reporter believing a
 * report that was never filed had been.
 *
 * **It renders nothing for a student**, who has no handle and so cannot write:
 * no control is better than a control whose only behaviour is to refuse.
 *
 * **The form is a modal in a portal, not inline.** The control sits in a
 * metadata line that is a paragraph, and a form cannot be nested in one; the
 * native `<dialog>` also brings focus containment and Escape for free.
 *
 * Product UI — merges into NUCarpool.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../server/community/moderation/domain/reportLimits";
import type { TargetType } from "../../server/community/content/public";
import type { ReportReason } from "../../server/community/moderation/public";
import { trpc } from "../../utils/trpc";
import { REPORT_REASONS } from "./reportReasons";
import { ErrorNote } from "./shell";

const ReportForm = ({
  targetType,
  targetId,
  onClose,
  onAcknowledged,
}: {
  targetType: TargetType;
  targetId: string;
  onClose: () => void;
  onAcknowledged: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  // Whether the current press began on the backdrop. A drag that selects text
  // in the textarea and releases outside the dialog produces a click whose
  // target is the dialog itself, and that must not discard the draft.
  const pressedBackdrop = useRef(false);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [message, setMessage] = useState("");
  const create = trpc.community.reports.create.useMutation({
    // **Never queue a report.** React Query's default `"online"` mode pauses a
    // mutation submitted while offline, keeps it in the mutation cache after
    // this form unmounts, and sends it on reconnect. For a reporter who closed
    // the dialog having seen no acknowledgement, a report that files itself
    // later is one they can neither know about nor undo; a report that was not
    // filed they can simply make again, and the unique triple converges a
    // retry to one row. `"always"` attempts the request regardless, so an
    // offline submit fails at once and reaches the `ErrorNote` below.
    //
    // **`retry: false` is part of the same guarantee, not noise.** A retrying
    // mutation can pause in its backoff while the window is unfocused and
    // resume on refocus, after this form has gone. With both pinned here, a
    // report is attempted exactly once and nothing is queued, by construction
    // and whatever mutation retry default the host client sets later. This
    // mutation only: the global client is not changed.
    networkMode: "always",
    retry: false,
    onSuccess: onAcknowledged,
  });

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const remaining = REPORT_MESSAGE_MAX_LENGTH - message.length;

  // The hold is on a request that is genuinely *in flight*, because only one
  // can still bring back a refusal. With `networkMode: "always"` above, this
  // mutation is never paused, so `isPaused` is expected to be false whenever
  // `isPending` is true and the second term is belt and braces. It stays so
  // that, if the network mode is ever changed, a paused mutation (pending
  // indefinitely) cannot trap the reporter in a modal over an inert page.
  // Do not simplify this to `isPending`.
  const inFlight = create.isPending && !create.isPaused;

  // Dismissal goes through `close()` so the browser restores focus to the
  // control that opened the dialog, as it does for Escape; unmounting an open
  // dialog does not do that reliably. The `close` event then reaches `onClose`.
  const dismiss = () => {
    if (inFlight) return;
    dialog.current?.close();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`report-title-${targetId}`}
      // Escape is `cancel`, then `close`. Held while the request is in flight.
      onCancel={(event) => {
        if (inFlight) event.preventDefault();
      }}
      // The open state follows the element rather than a second key handler.
      // A browser that closes despite the prevented `cancel` (Chrome allows
      // one prevention per user gesture) is reopened, so a late refusal still
      // has somewhere to appear.
      onClose={() => {
        if (inFlight) dialog.current?.showModal();
        else onClose();
      }}
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === dialog.current;
      }}
      onClick={(event) => {
        // Only a click on the backdrop has the dialog itself as its target, and
        // only one that also began there is a dismissal.
        if (event.target === dialog.current && pressedBackdrop.current) {
          dismiss();
        }
        pressedBackdrop.current = false;
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-md p-0 text-gray-800 shadow-xl backdrop:bg-black/40"
    >
      <form
        className="p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason === null) return;
          const trimmed = message.trim();
          create.mutate({
            targetType,
            targetId,
            reason,
            message: trimmed.length > 0 ? trimmed : undefined,
          });
        }}
      >
        <h2
          id={`report-title-${targetId}`}
          className="font-montserrat text-base font-bold"
        >
          Report this {targetType === "POST" ? "post" : "reply"}
        </h2>

        <fieldset className="mt-4">
          <legend className="text-sm text-gray-600">
            What is the problem?
          </legend>
          <div className="mt-2 space-y-1">
            {REPORT_REASONS.map((option) => (
              <label
                key={option.value}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name={`report-reason-${targetId}`}
                  value={option.value}
                  checked={reason === option.value}
                  onChange={() => setReason(option.value)}
                  className="accent-northeastern-red"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>

        <label
          htmlFor={`report-message-${targetId}`}
          className="mt-4 block text-sm text-gray-600"
        >
          Anything else a moderator should know? (optional)
        </label>
        <textarea
          id={`report-message-${targetId}`}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={3}
          maxLength={REPORT_MESSAGE_MAX_LENGTH}
          className="focus:border-northeastern-red mt-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:outline-none"
        />
        {/* As in the reply composer, the counter appears only as the limit
            comes into view. */}
        <p className="mt-1 h-4 text-xs text-gray-400">
          {remaining <= 100 ? `${remaining} characters left` : ""}
        </p>

        {create.error ? <ErrorNote>{create.error.message}</ErrorNote> : null}

        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={dismiss}
            disabled={inFlight}
            className="focus-visible:outline-northeastern-red rounded text-sm text-gray-600 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={reason === null || create.isPending}
            className="bg-northeastern-red font-montserrat rounded-md px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-[#a60d26] disabled:opacity-40"
          >
            {create.isPending ? "Sending…" : "Send report"}
          </button>
        </div>
      </form>
    </dialog>
  );
};

export const ReportControl = ({
  targetType,
  targetId,
  canReport,
}: {
  targetType: TargetType;
  targetId: string;
  /** False for a student, who has no handle and so cannot write. */
  canReport: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const status = useRef<HTMLSpanElement>(null);

  // The button that held focus is gone by now. Moving focus to the
  // acknowledgement keeps the reader's place and gets it read out, which a
  // status element inserted already containing its text does not reliably do.
  useEffect(() => {
    if (acknowledged) status.current?.focus();
  }, [acknowledged]);

  if (!canReport) return null;

  if (acknowledged) {
    // One sentence, whatever happened to the content. See the file header.
    return (
      <span ref={status} role="status" tabIndex={-1} className="outline-none">
        Report received. Thank you.
      </span>
    );
  }

  const noun = targetType === "POST" ? "post" : "reply";

  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        // A feed is a column of these, so each names what it reports.
        aria-label={`Report this ${noun}`}
        aria-haspopup="dialog"
        className="focus-visible:outline-northeastern-red rounded transition-colors hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Report
      </button>
      {open
        ? createPortal(
            <ReportForm
              targetType={targetType}
              targetId={targetId}
              onClose={() => setOpen(false)}
              onAcknowledged={() => {
                setOpen(false);
                setAcknowledged(true);
              }}
            />,
            document.body,
          )
        : null}
    </span>
  );
};
