/**
 * One post, as a list renders it.
 *
 * **Extracted because there are now two lists.** The feed and the saved list
 * show the same thing and differ only in what they are a list *of*; keeping
 * one copy of the row is what stops the two from drifting into showing
 * different facts about the same post.
 *
 * Product UI — merges into NUCarpool.
 */
import Link from "next/link";
import type { PublicPost } from "../../server/community/content/public";
import { HandleLink } from "./handleLink";
import { ReportControl } from "./reportDialog";
import { SaveButton } from "./saveButton";
import { timeAgo } from "./timeAgo";
import { VoteButton } from "./voteButton";

export const PostRow = ({
  post,
  canWrite,
  onChanged,
}: {
  post: PublicPost;
  /** False for a student, who has no handle and so can neither vote, save nor report. */
  canWrite: boolean;
  onChanged: () => Promise<unknown> | void;
}) => (
  <li className="flex gap-3 py-4">
    <VoteButton
      postId={post.id}
      voteCount={post.voteCount}
      viewerHasVoted={post.viewerHasVoted}
      canVote={canWrite}
      onChanged={onChanged}
    />

    <div className="min-w-0 flex-1">
      <h2 className="font-montserrat text-base leading-snug font-bold">
        <Link
          href={`/community/${post.id}`}
          className="hover:text-northeastern-red focus-visible:outline-northeastern-red focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {post.title}
        </Link>
      </h2>
      {/* Two lines of the body, so the list previews the post without
          becoming the post. */}
      <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-gray-600">
        {post.content}
      </p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
        <HandleLink handle={post.author.handle} />
        <span className="rounded bg-gray-100 px-1.5 py-0.5">
          {post.categorySlug}
        </span>
        <span>{timeAgo(post.dateCreated)}</span>
        {post.edited ? <span>edited</span> : null}
        <Link
          href={`/community/${post.id}`}
          className="hover:text-northeastern-red"
        >
          {post.commentCount === 1
            ? "1 comment"
            : `${post.commentCount} comments`}
        </Link>
        <SaveButton
          postId={post.id}
          viewerHasSaved={post.viewerHasSaved}
          canSave={canWrite}
          onChanged={onChanged}
        />
        {/* **No report control on your own post**, matching the post page.
            Reporting yourself files a row a moderator then has to read, and an
            author who wants their own post gone has Delete on the post itself.
            The row deliberately carries no Edit or Delete of its own: a list is
            for reading, and a destructive control in a scrolling list is one
            mis-tap from a post the author cannot restore. */}
        {post.viewerIsAuthor ? null : (
          <ReportControl
            targetType="POST"
            targetId={post.id}
            canReport={canWrite}
          />
        )}
      </p>
    </div>
  </li>
);
