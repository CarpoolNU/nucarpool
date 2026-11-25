/**
 * The save control.
 *
 * **It calls two distinct procedures, never a toggle** — the UI half of the
 * guarantee `SavedPostService` makes server-side (spec §10.1). The button
 * reads the current state to decide *which* of the two to call, but a retry of
 * either one repeats the user's intent rather than inverting it.
 *
 * **Deliberately not shaped like `VoteButton`.** A vote is a public signal
 * with a number attached, so it gets the left rail and a count; a save is
 * private to one person and has no number anyone may see, so it sits in the
 * metadata line as one more fact about this post and this reader.
 *
 * **It surfaces a refusal, for the same reason `VoteButton` does.** Neither is
 * optimistic: both refetch through `onSettled`, so a refused save restores the
 * outlined bookmark and says nothing, which is perceptually identical to a save
 * that worked. Spec §10 names exactly that failure. The control became capable
 * of refusing when `saved.save` took the `SAVE` budget (SCRUM-686), so the
 * surface arrives with it.
 *
 * Product UI — merges into NUCarpool.
 */
import { trpc } from "../../utils/trpc";
import { ErrorNote } from "./shell";

export const SaveButton = ({
  postId,
  viewerHasSaved,
  canSave,
  onChanged,
}: {
  postId: string;
  viewerHasSaved: boolean;
  /** False for a student, who has no handle and so cannot write. */
  canSave: boolean;
  onChanged: () => Promise<unknown> | void;
}) => {
  const settled = () => onChanged();
  const save = trpc.community.saved.save.useMutation({ onSettled: settled });
  const unsave = trpc.community.saved.unsave.useMutation({
    onSettled: settled,
  });
  const pending = save.isPending || unsave.isPending;

  // Both are reset on click, so at most one of them is ever holding an error
  // and a refusal followed by a success does not leave the refusal on screen.
  const error = save.error ?? unsave.error;

  const act = () => {
    save.reset();
    unsave.reset();
    (viewerHasSaved ? unsave : save).mutate({ postId });
  };

  return (
    // The metadata line this sits in is horizontal, so the note goes beside the
    // label rather than beneath it — no wrapper width to manage, which is why
    // this needs none of `VoteButton`'s gutter arithmetic.
    <span className="flex flex-wrap items-center gap-x-2">
      <button
        type="button"
        disabled={!canSave || pending}
        aria-pressed={viewerHasSaved}
        aria-label={viewerHasSaved ? "Remove from saved" : "Save this post"}
        title={canSave ? undefined : "Choose a handle to save posts"}
        onClick={act}
        className={`focus-visible:outline-northeastern-red flex items-center gap-1 rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
          viewerHasSaved
            ? "text-northeastern-red font-bold"
            : "hover:text-gray-900"
        }`}
      >
        {/* A bookmark, filled when kept and outlined when not: the same glyph in
          both states, so the change reads as this post's state rather than as
          two different controls. It inherits `currentColor`, which is what
          carries the active state alongside the label. */}
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
          <path
            d="M4.25 2.25h7.5v11.5L8 11.25l-3.75 2.5z"
            fill={viewerHasSaved ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinejoin="round"
          />
        </svg>
        {viewerHasSaved ? "Saved" : "Save"}
      </button>

      {/* `ErrorNote` already carries role="alert", so the refusal is announced
          without any further ARIA work. It renders as a `<span>` here because
          both call sites put this control in a metadata line that is itself a
          `<p>`, and the default `<p>` would be nested in one — the constraint
          `ReportControl` answers with a portal. `role="alert"` does the
          announcing either way. */}
      {error ? <ErrorNote as="span">{error.message}</ErrorNote> : null}
    </span>
  );
};
