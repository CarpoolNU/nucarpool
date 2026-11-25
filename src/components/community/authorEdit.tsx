/**
 * The author's own controls: edit, and delete.
 *
 * **They render only when the server says the viewer wrote it.**
 * `viewerIsAuthor` is a field on `PublicPost` and `PublicComment`, decided
 * server-side; this file never compares handles to work it out. See that
 * field's doc comment for why the browser must not.
 *
 * **Rendering them is not what permits them.** Every procedure behind these
 * buttons re-resolves the row and refuses a non-author with `FORBIDDEN`, and
 * refuses everyone once the row is hidden or deleted. The flag decides what to
 * show; the server decides what happens.
 *
 * **Delete confirms inline rather than in a modal.** `ReportControl` uses a
 * portal because it has a form to put somewhere a `<p>` cannot hold one; this
 * has two buttons, which are phrasing content and sit in the metadata line
 * directly. The confirm is not decoration: the soft delete has no author-facing
 * undo, so one stray click would be unrecoverable for the person who made it.
 *
 * **A refusal is always shown.** A delete that lost to a moderator's hide comes
 * back `NOT_FOUND` and an author who saw nothing would believe their content
 * was still live.
 *
 * Product UI — merges into NUCarpool.
 */
import { useState } from "react";
import {
  COMMENT_CONTENT_MAX_LENGTH,
  POST_CONTENT_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
} from "../../server/community/content/domain/textLimits";
import type {
  PublicComment,
  PublicPost,
} from "../../server/community/content/public";
import { trpc } from "../../utils/trpc";
import { editDraftState } from "./editDraft";
import { ErrorNote } from "./shell";

/** The one sentence a blocked draft gets, per reason. */
const BLOCKED_NOTE = {
  empty: "Nothing to save — the text is empty.",
  "too-long": "Too long to save.",
  unchanged: "No changes yet.",
} as const;

const linkButton =
  "text-xs text-gray-500 underline underline-offset-2 hover:text-northeastern-red disabled:no-underline disabled:opacity-40";

/**
 * Edit and Delete, with Delete behind a confirm.
 *
 * `busy` holds both buttons while *either* request is in flight, so a delete
 * cannot be fired at a row an edit is still writing.
 */
export const AuthorActions = ({
  noun,
  busy,
  onEdit,
  onDelete,
}: {
  /** "post" or "reply" — what the confirm asks about. */
  noun: string;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <>
        <span className="text-xs text-gray-600">Delete this {noun}?</span>
        <button
          type="button"
          disabled={busy}
          onClick={onDelete}
          className="text-northeastern-red text-xs font-bold underline underline-offset-2 disabled:opacity-40"
        >
          {busy ? "Deleting…" : "Yes, delete"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(false)}
          className={linkButton}
        >
          Keep it
        </button>
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={onEdit}
        className={linkButton}
      >
        Edit
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setConfirming(true)}
        className={linkButton}
      >
        Delete
      </button>
    </>
  );
};

/** The character counter, which appears only as a limit comes into view. */
const Counter = ({ value, max }: { value: string; max: number }) => {
  const remaining = max - value.trim().length;
  if (remaining > 200) {
    return <span />;
  }
  return (
    <span
      className={`text-xs ${remaining < 0 ? "text-northeastern-red" : "text-gray-400"}`}
    >
      {remaining} characters left
    </span>
  );
};

/**
 * The post editor, shown in place of the title and body.
 *
 * **There is no category picker**, matching `posts.edit`, which takes none: a
 * post gathers its votes, comments and saves inside a category, and moving it
 * would move that history under readers who never chose it.
 */
export const PostEditor = ({
  post,
  onSaved,
  onCancel,
}: {
  post: PublicPost;
  onSaved: () => Promise<unknown> | void;
  onCancel: () => void;
}) => {
  const [title, setTitle] = useState(post.title);
  const [content, setContent] = useState(post.content);

  const edit = trpc.community.posts.edit.useMutation({
    onSuccess: async () => {
      await onSaved();
      onCancel();
    },
  });

  const draft = editDraftState([
    { value: title, original: post.title, max: POST_TITLE_MAX_LENGTH },
    { value: content, original: post.content, max: POST_CONTENT_MAX_LENGTH },
  ]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        edit.mutate({ postId: post.id, title, content });
      }}
    >
      <label htmlFor="edit-title" className="font-montserrat text-sm font-bold">
        Title
      </label>
      <input
        id="edit-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="font-montserrat focus:border-northeastern-red mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-lg leading-tight font-bold focus:outline-none"
      />
      <Counter value={title} max={POST_TITLE_MAX_LENGTH} />

      <label
        htmlFor="edit-content"
        className="font-montserrat mt-4 block text-sm font-bold"
      >
        Body
      </label>
      <textarea
        id="edit-content"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={8}
        className="focus:border-northeastern-red mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-base leading-relaxed focus:outline-none"
      />

      <div className="mt-2 flex items-center justify-between gap-3">
        <Counter value={content} max={POST_CONTENT_MAX_LENGTH} />
        <div className="flex items-center gap-3">
          {draft.blockedBy ? (
            <span className="text-xs text-gray-500">
              {BLOCKED_NOTE[draft.blockedBy]}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            disabled={edit.isPending}
            className={linkButton}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={edit.isPending || !draft.canSubmit}
            className="bg-northeastern-red font-montserrat rounded-md px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-[#a60d26] disabled:opacity-40"
          >
            {edit.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
      {edit.error ? <ErrorNote>{edit.error.message}</ErrorNote> : null}
    </form>
  );
};

/** The reply editor, shown in place of a comment's body. */
export const CommentEditor = ({
  comment,
  onSaved,
  onCancel,
}: {
  comment: PublicComment;
  onSaved: () => Promise<unknown> | void;
  onCancel: () => void;
}) => {
  const [content, setContent] = useState(comment.content);

  const edit = trpc.community.comments.edit.useMutation({
    onSuccess: async () => {
      await onSaved();
      onCancel();
    },
  });

  const draft = editDraftState([
    {
      value: content,
      original: comment.content,
      max: COMMENT_CONTENT_MAX_LENGTH,
    },
  ]);

  return (
    <form
      className="mt-1"
      onSubmit={(event) => {
        event.preventDefault();
        edit.mutate({ commentId: comment.id, content });
      }}
    >
      <label htmlFor={`edit-${comment.id}`} className="sr-only">
        Edit your reply
      </label>
      <textarea
        id={`edit-${comment.id}`}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        rows={3}
        className="focus:border-northeastern-red w-full rounded-md border border-gray-300 px-3 py-2 text-sm leading-relaxed focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <Counter value={content} max={COMMENT_CONTENT_MAX_LENGTH} />
        <div className="flex items-center gap-3">
          {draft.blockedBy ? (
            <span className="text-xs text-gray-500">
              {BLOCKED_NOTE[draft.blockedBy]}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            disabled={edit.isPending}
            className={linkButton}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={edit.isPending || !draft.canSubmit}
            className="bg-northeastern-red font-montserrat rounded-md px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#a60d26] disabled:opacity-40"
          >
            {edit.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      {edit.error ? <ErrorNote>{edit.error.message}</ErrorNote> : null}
    </form>
  );
};
