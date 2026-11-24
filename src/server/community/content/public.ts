import type { CommunityActor } from "../actor";
import type { StoredCategory, StoredComment, StoredPost } from "./ports";

/**
 * A post as any community member may see it.
 *
 * **This type has no `authorId` field**, and that is the privacy mechanism.
 * Identity does not leak by someone forgetting to delete a property before
 * serializing; it would require adding a field to a type whose name says it is
 * public, in a file whose name says it is the boundary.
 *
 * The author is a handle and nothing else — no real name, no co-op employer,
 * no carpool role, nothing platform-derived.
 */
export type PublicPost = {
  id: string;
  title: string;
  content: string;
  categorySlug: string;
  author: { handle: string };
  voteCount: number;
  commentCount: number;
  /**
   * Whether *this* caller has upvoted it.
   *
   * Per-viewer, so it is the one field on this type that differs between two
   * people reading the same post. It is also the reason a feed response cannot
   * be cached across users.
   */
  viewerHasVoted: boolean;
  /**
   * Whether *this* caller has saved it. Per-viewer in exactly the same way as
   * {@link PublicPost.viewerHasVoted}, and for the same reason a feed response
   * cannot be cached across users.
   */
  viewerHasSaved: boolean;
  /**
   * Whether *this* caller wrote it, and therefore may edit or delete it.
   *
   * **Answered here rather than inferred in the browser.** Comparing
   * `author.handle` against the viewer's own handle would look equivalent and
   * is not: an author whose profile row is missing renders as
   * {@link UNKNOWN_AUTHOR_HANDLE}, so two such posts compare equal to each
   * other — and to a viewer whose own handle failed to resolve. That turns a
   * rendering gap into an Edit button over someone else's writing.
   *
   * **It discloses nothing new.** Like {@link PublicPost.viewerHasVoted} it is
   * a fact about the caller, who already knows it; it says nothing about the
   * author, which is what keeps `authorId` off this type in the first place.
   * The server still enforces authorship on every write — this field decides
   * what to render, never what is allowed.
   */
  viewerIsAuthor: boolean;
  dateCreated: Date;
  /** Whether the author has edited it, not when. */
  edited: boolean;
};

export type PublicCategory = {
  slug: string;
  name: string;
  description: string;
};

/**
 * The handle shown when a post's author has no profile row.
 *
 * Unreachable today — a post cannot be created without a `member` actor, which
 * requires a profile — but the lookup is a join that a future purge or a
 * partially-applied migration could leave short, and rendering `undefined` on
 * a public page is worse than rendering this.
 */
export const UNKNOWN_AUTHOR_HANDLE = "unknown";

export const toPublicPost = (
  post: StoredPost,
  categorySlug: string,
  authorHandle: string | undefined,
  viewerHasVoted = false,
  viewerHasSaved = false,
  viewerIsAuthor = false,
): PublicPost => ({
  id: post.id,
  title: post.title,
  content: post.content,
  categorySlug,
  author: { handle: authorHandle ?? UNKNOWN_AUTHOR_HANDLE },
  voteCount: post.voteCount,
  commentCount: post.commentCount,
  viewerHasVoted,
  viewerHasSaved,
  viewerIsAuthor,
  dateCreated: post.dateCreated,
  edited: post.editedAt !== null,
});

export const toPublicCategory = (category: StoredCategory): PublicCategory => ({
  slug: category.slug,
  name: category.name,
  description: category.description,
});

/**
 * A comment as any community member may see it.
 *
 * **No `authorId`, and no `postId` either.** The first is the same privacy
 * mechanism as {@link PublicPost}: identity cannot leak by someone forgetting
 * to strip a field, because the field does not exist. The second is scope — a
 * comment is only ever served as part of a thread the caller already named, so
 * echoing the parent id back adds nothing and invites a client to treat it as a
 * handle on content it has not been authorized for.
 */
export type PublicComment = {
  id: string;
  content: string;
  author: { handle: string };
  dateCreated: Date;
  /** Whether the author has edited it, not when. */
  edited: boolean;
  /**
   * Whether *this* caller wrote it. The same per-viewer fact as
   * {@link PublicPost.viewerIsAuthor}, decided on the server for the same
   * reason, and used for the same purpose: what to render, never what is
   * permitted.
   */
  viewerIsAuthor: boolean;
};

export const toPublicComment = (
  comment: StoredComment,
  authorHandle: string | undefined,
  viewerIsAuthor = false,
): PublicComment => ({
  id: comment.id,
  content: comment.content,
  author: { handle: authorHandle ?? UNKNOWN_AUTHOR_HANDLE },
  dateCreated: comment.dateCreated,
  edited: comment.editedAt !== null,
  viewerIsAuthor,
});

/**
 * Posts in their public shape, by id, for a module that holds ids and not
 * posts.
 *
 * **This is how `engagement` renders a saved list without owning posts.** The
 * saved list is a page of bookmark rows; turning those into something a client
 * can display needs the author's handle, the category slug and the viewer's
 * own vote and save state — all of which `content` already assembles for the
 * feed. Declaring the shape here and implementing it on `PostService` means
 * that assembly happens once, and `engagement` depends on an interface rather
 * than on `content`'s service.
 */
export interface PublicPostReader {
  /**
   * The given posts, in the given order, minus the ones this actor may not
   * see.
   *
   * **Order is the caller's, not the feed's.** A saved list is ordered by when
   * each post was saved, which has nothing to do with when it was written or
   * how it has been voted on, so preserving the input order is the whole
   * contract. Posts the actor may not see are omitted — see
   * {@link PostBatchReader.findVisibleByIds} for why that is not an error.
   */
  visibleByIds(
    actor: CommunityActor,
    postIds: readonly string[],
  ): Promise<readonly PublicPost[]>;
}

/** What a report can point at. `moderation` imports this rather than redeclaring it. */
export type TargetType = "POST" | "COMMENT";

/**
 * A report target, as `moderation` needs it. Carries no ids beyond the
 * author's — not the post a comment sits under, not the category — because
 * the reporter is never shown it and the moderator needs only who wrote it and
 * what it said (spec §13.1).
 */
export type ContentTarget = {
  authorId: string;
  /**
   * The server-built evidence copy taken when a report is filed.
   *
   * **Built from the stored row, and no caller-supplied string ever reaches
   * it.** That is what makes it evidence: the author may edit or delete the
   * original afterwards, and the copy still says what the reporter saw rather
   * than what the reporter claimed they saw.
   */
  snapshot: string;
};

/**
 * Reads a post or a comment as a report target.
 *
 * **`moderation` takes this, never `PostRepository` or `CommentRepository`** —
 * the same inversion that gives `content` a `ProfileReader` rather than
 * `identity`'s repository. `content` declares `TargetType` and publishes it,
 * `moderation` imports it, and the `switch` over it lives in `ContentTargets`
 * and nowhere else, so what each arm means stays in `content`.
 */
export interface ContentTargetReader {
  /**
   * The target, or `null` if the caller may not see it.
   *
   * **Absent, deleted, hidden, blocked-author and the wrong type are one
   * return value**, for the reason `PostReader.findVisibleById` gives:
   * telling them apart would let a caller probe ids.
   */
  findVisibleTarget(
    type: TargetType,
    id: string,
    excludeAuthorIds: readonly string[],
  ): Promise<ContentTarget | null>;
}

/**
 * Hides a post or a comment, and brings it back.
 *
 * **Hide, never delete.** The row stays with `hiddenAt` set, which is what
 * makes a bad call reversible — and `restore` is the reversal, which until it
 * existed was reversible only in principle.
 */
export interface ContentTargetHider {
  /** Idempotent; preserves the first `hiddenAt`. Returns whether a row moved. */
  hide(type: TargetType, id: string, hiddenAt: Date): Promise<boolean>;

  /**
   * Clears `hiddenAt`. Idempotent; returns whether a row moved, so `false`
   * covers a target that was not hidden and one that is not there.
   */
  restore(type: TargetType, id: string): Promise<boolean>;
}
