import { toast } from "react-toastify/unstyled";
import { FEEDBACK_FORM_URL } from "../../utils/feedbackForm";

/**
 * The success toast for a membership change, with a link to the feedback form.
 *
 * Every mutation `useGroupMembership` performs ends at least one pairing the
 * caller was part of - they left, they removed somebody, or the group was
 * dissolved - so every one of its success toasts carries the prompt. This is
 * the post-match feedback of SCRUM-545, routed to the existing Jira form
 * instead of a table of our own: the app keeps no record of a pairing once it
 * ends (`docs/design/post-match-feedback.md`), and nothing here reads a
 * submission back, so the rated user is never shown one.
 *
 * It reaches only the member who acted. A rider the driver removed, and the
 * member left behind when a group dissolves under them, are not in the app at
 * that moment and are not prompted. That gap was accepted with the scope.
 *
 * `autoClose: false` because the toast now holds a link. A link that vanishes
 * after five seconds cannot be reached by anyone slower than that (WCAG 2.2.1),
 * and the container's `closeOnClick` still dismisses it on any tap, including
 * the tap on the link itself.
 */
export const CarpoolEndedToast = ({ message }: { message: string }) => (
  <div>
    <p>{message}</p>
    <a
      href={FEEDBACK_FORM_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-block text-sm font-medium underline"
    >
      Tell us how the carpool went
    </a>
  </div>
);

export const toastCarpoolEnded = (message: string) =>
  toast.success(<CarpoolEndedToast message={message} />, { autoClose: false });
