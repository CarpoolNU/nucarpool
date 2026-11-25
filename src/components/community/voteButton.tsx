/**
 * The upvote control.
 *
 * **It calls two distinct procedures, never a toggle** — which is the UI half
 * of the guarantee `VoteService` makes server-side (spec §10.1). The button
 * reads the current state to decide *which* of the two to call, but a retry of
 * either one repeats the user's intent rather than inverting it.
 *
 * **It is the one write surface that needs its own error state**, and not for
 * the reason it first appears. It is not optimistic — it disables while pending
 * and refetches through `onSettled` — so there is no optimistic count to roll
 * back. The problem is the opposite: because the refetch restores the correct
 * count on any outcome, a refused vote otherwise produces *nothing a user can
 * perceive*. The button re-enables, the number is unchanged, and a rate-limited
 * vote looks exactly like a vote that worked on a post already at that count.
 *
 * Product UI — merges into NUCarpool.
 */
import { trpc } from "../../utils/trpc";
import { ErrorNote } from "./shell";

export const VoteButton = ({
  postId,
  voteCount,
  viewerHasVoted,
  canVote,
  onChanged,
}: {
  postId: string;
  voteCount: number;
  viewerHasVoted: boolean;
  /** False for a student, who has no handle and so cannot write. */
  canVote: boolean;
  onChanged: () => Promise<unknown> | void;
}) => {
  const settled = () => onChanged();
  const vote = trpc.community.votes.vote.useMutation({ onSettled: settled });
  const unvote = trpc.community.votes.unvote.useMutation({
    onSettled: settled,
  });
  const pending = vote.isPending || unvote.isPending;

  // Both are reset on click, so at most one of them is ever holding an error:
  // a refusal followed by a successful vote does not leave the refusal on
  // screen. Without the reset, the two mutations keep independent error state
  // and the stale one would outlive the attempt that produced it.
  const error = vote.error ?? unvote.error;

  const act = () => {
    vote.reset();
    unvote.reset();
    (viewerHasVoted ? unvote : vote).mutate({ postId });
  };

  return (
    // The column wrapper exists so the refusal can be read. The no-shrink
    // utility moves here from the button, and the gutter widens only while a
    // message is on screen — acceptable because that state is rare and
    // transient, and far cheaper than threading per-row error state through
    // both the feed and the post page. The button keeps its own fixed width so
    // the hit target does not move.
    <div
      className={`flex shrink-0 flex-col items-center ${error ? "w-28" : "w-12"}`}
    >
      <button
        type="button"
        disabled={!canVote || pending}
        aria-pressed={viewerHasVoted}
        aria-label={viewerHasVoted ? "Remove your upvote" : "Upvote this post"}
        title={canVote ? undefined : "Choose a handle to vote"}
        onClick={act}
        className={`focus-visible:outline-northeastern-red flex w-12 flex-col items-center gap-0.5 rounded-md py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
          viewerHasVoted
            ? "bg-light-red text-northeastern-red"
            : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        }`}
      >
        {/* A caret, not an emoji: it inherits `currentColor`, so the active state
          is carried by the same token as the count beneath it. */}
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
          <path d="M8 2.5 14.5 11h-13z" fill="currentColor" />
        </svg>
        <span
          className={`font-montserrat text-sm tabular-nums ${
            viewerHasVoted ? "font-bold" : ""
          } ${voteCount === 0 ? "text-gray-400" : ""}`}
        >
          {voteCount}
        </span>
      </button>

      {/* `ErrorNote` already carries role="alert", so the refusal is announced
          without any further ARIA work. */}
      {error ? <ErrorNote>{error.message}</ErrorNote> : null}
    </div>
  );
};
