import type { Cursor, NewCursor, SortKey } from "../shared/cursor";

export type StoredCategory = {
  id: string;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
};

export type StoredPost = {
  id: string;
  authorId: string;
  categoryId: string;
  title: string;
  content: string;
  voteCount: number;
  commentCount: number;
  hiddenAt: Date | null;
  deletedAt: Date | null;
  editedAt: Date | null;
  dateCreated: Date;
};

export type ListPostsQuery = {
  categoryId: string | null;
  /**
   * A substring to look for in the title or the content, or `null` for the
   * unfiltered feed.
   *
   * **Raw, not a `LIKE` pattern.** Every implementation of this port owes the
   * same meaning — a case-insensitive literal substring of either field — and
   * each reaches it its own way: the Prisma repository escapes the wildcards
   * MySQL would otherwise honour inside the bound value, the in-memory fake
   * lowercases both sides and calls `includes`. Handing a pre-escaped pattern
   * down instead would make the fake un-escape it to do a string comparison,
   * which is a second implementation of the escaping and therefore a second
   * thing that can be wrong.
   *
   * **The term is trimmed and length-checked before it arrives**, by
   * `normalizeSearchTerm` in the service — so `""` never reaches here as a
   * predicate matching every row.
   *
   * **No index serves this.** `community_post` declares three keyset tuples
   * and none of them can satisfy a leading-wildcard `LIKE`, so a search is a
   * scan of the category's rows. That is the documented launch-volume trade
   * (spec §16.2); `FULLTEXT` is the additive upgrade when it stops being one.
   */
  search: string | null;
  /**
   * Which ordering, and therefore which keyset tuple.
   *
   * **Required rather than defaulted**, because the default belongs to the
   * service: a repository that silently picked an order when asked for none
   * would be a second place the feed's ordering is decided.
   */
  sort: SortKey;
  /**
   * Where the previous page ended. Its `sort` always matches {@link sort} —
   * the codec refuses a cursor issued under the other one before it reaches
   * here, so this is never a tuple the ordering cannot use.
   */
  after: Cursor | null;
  /**
   * The service asks for one more row than the page size, so "is there a next
   * page?" is answered without a second COUNT query.
   */
  limit: number;
  /**
   * Authors whose posts must not appear: the caller's block counterparts, in
   * either direction. **Filtering, never deleting** — NUCarpool's block
   * doctrine is that content between a blocked pair is hidden where it is read
   * so that unblocking restores it exactly and nothing a later report needs is
   * lost.
   */
  excludeAuthorIds: readonly string[];
};

/**
 * One page of a single author's posts, newest first.
 *
 * **No `excludeAuthorIds`, unlike {@link ListPostsQuery}, and the absence is
 * the design.** A feed mixes authors, so it filters them row by row. This
 * query has exactly one author, and whether the caller may see that author at
 * all has already been decided — by `requireVisibleProfile`, before this is
 * reached, as a refusal rather than as an empty list. Repeating the block
 * predicate here would be a second answer to a question already answered, and
 * a `NOT IN` that can never match anything.
 */
export type ListAuthoredPostsQuery = {
  authorId: string;
  /**
   * Where the previous page ended. Newest-first only — a profile has no Top
   * order, because ranking one person's own posts against each other answers
   * a question nobody asked.
   */
  after: NewCursor | null;
  /** One more than the page size, as in {@link ListPostsQuery}. */
  limit: number;
};

export interface CategoryRepository {
  findBySlug(slug: string): Promise<StoredCategory | null>;

  /**
   * The categories with these ids, active or not, in no particular order.
   *
   * **Active or not is the whole point.** A post outlives the retirement of
   * its category, so the read path needs the label of a category that
   * {@link listActive} no longer returns; resolving slugs from the active list
   * is what used to blank the label on every post in a retired category
   * (SCRUM-690).
   *
   * Shorter than its input is ordinary: `community_category` has no foreign
   * key pointing at it under `relationMode = "prisma"`.
   *
   * Empty input must not become a query, as on {@link ViewerVoteReader}.
   */
  findManyByIds(ids: readonly string[]): Promise<readonly StoredCategory[]>;

  /**
   * The categories a post may be written to, in display order.
   *
   * **This is the offer, not the archive.** It backs the composer's picker and
   * the feed's filter chips, so retiring a category removes it from both
   * without touching a single post.
   */
  listActive(): Promise<readonly StoredCategory[]>;
}

/**
 * The read-only post view `content` publishes to other modules.
 *
 * **`engagement` takes this, never `PostRepository`.** A vote must refuse a
 * post the caller cannot see, so the engagement module needs exactly one fact
 * about posts and no ability to write them — the same inversion that gives
 * `content` a `ProfileReader` rather than `identity`'s repository.
 */
export interface PostReader {
  /**
   * One post, or `null` if the caller may not see it.
   *
   * **The four reasons for `null` are deliberately one return value**: no such
   * id, author-deleted, moderator-hidden, or authored by a block counterpart.
   * Distinguishing them here would let the transport layer distinguish them
   * too, and a caller who can tell "hidden" from "absent" can probe handles to
   * map them onto people they have blocks with (spec §7.2).
   */
  findVisibleById(
    postId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredPost | null>;
}

export interface PostRepository extends PostReader, PostBatchReader {
  insert(input: {
    authorId: string;
    categoryId: string;
    title: string;
    content: string;
    dateCreated: Date;
  }): Promise<StoredPost>;

  /**
   * One page in the requested order, excluding hidden, deleted and
   * blocked-author rows.
   */
  list(query: ListPostsQuery): Promise<readonly StoredPost[]>;

  /**
   * One page of a single author's posts, newest first.
   *
   * Hidden and deleted rows are excluded exactly as they are everywhere else,
   * so a profile cannot become a way to read what the feed declined to show.
   */
  listByAuthor(query: ListAuthoredPostsQuery): Promise<readonly StoredPost[]>;

  /**
   * Sets `hiddenAt`, once. Returns whether a row moved.
   *
   * **Idempotent, and the first hide wins.** Hiding an already-hidden post
   * changes nothing and returns `false`, so the timestamp an audit refers back
   * to is the moment of the first decision rather than the last click. **Hide,
   * never delete**: the row stays, which is what makes a bad call reversible.
   *
   * `false` also covers an id that is not there; the caller does not need to
   * tell the two apart, and a write that moved nothing is not an error.
   */
  hide(postId: string, hiddenAt: Date): Promise<boolean>;

  /**
   * Clears `hiddenAt`. Returns whether a row moved.
   *
   * **The mirror of {@link hide}**, and idempotent for the same reason:
   * restoring a post that is already visible changes nothing and returns
   * `false`, so the caller learns what actually happened rather than what it
   * asked for. `false` also covers an id that is not there.
   */
  unhide(postId: string): Promise<boolean>;

  /**
   * Rewrites an author's own title and body, returning the updated row or
   * `null` if nothing matched.
   *
   * **The whole permission is in the predicate, not only in the service.** The
   * update matches on `authorId` *and* on the row still being neither hidden
   * nor deleted, so the three ways an edit should fail — wrong author, a
   * moderator's hide, an author's own earlier delete — are decided by the
   * same statement that writes. The service reads the row first, but only to
   * tell a non-author (`NOT_AUTHOR`) from content that is gone
   * (`CONTENT_UNAVAILABLE`); between that read and this write a moderator can
   * hide the post, and this predicate is what makes the edit lose that race
   * instead of landing on hidden content.
   *
   * **`dateCreated` is untouched and `editedAt` is the only timestamp
   * written** — spec §8's rule that only the edit path writes `editedAt`, and
   * the reason an edit does not bump the post up the New feed.
   */
  editByAuthor(input: {
    postId: string;
    authorId: string;
    title: string;
    content: string;
    editedAt: Date;
  }): Promise<StoredPost | null>;

  /**
   * Sets `deletedAt` on an author's own post. Returns whether a row moved.
   *
   * **`deletedAt`, never `hiddenAt`** (spec §8): the two columns answer
   * different questions, and collapsing them would make "did a moderator act
   * here?" unanswerable. The row stays, so a report filed against it still has
   * its target.
   *
   * The predicate carries `hiddenAt IS NULL` for the reason
   * {@link editByAuthor} does: an author must not be able to overwrite a
   * moderator's record of what happened to this row with their own.
   */
  softDeleteByAuthor(input: {
    postId: string;
    authorId: string;
    deletedAt: Date;
  }): Promise<boolean>;
}

export type StoredComment = {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  hiddenAt: Date | null;
  deletedAt: Date | null;
  editedAt: Date | null;
  dateCreated: Date;
};

export type ListCommentsQuery = {
  postId: string;
  after: NewCursor | null;
  /** One more than the page size, as in {@link ListPostsQuery}. */
  limit: number;
  /** The caller's block counterparts. Same filtering doctrine as posts. */
  excludeAuthorIds: readonly string[];
};

/**
 * A comment insert that cannot orphan its post.
 *
 * **The parent read and the insert are one atomic unit, and that is a
 * persistence concern rather than a service one.** Under
 * `relationMode = "prisma"` MySQL enforces no foreign key, so a plain
 * check-then-insert can interleave with a hard delete of the post and leave a
 * comment pointing at nothing (spec §6.2).
 *
 * The spec puts the `SELECT ... FOR UPDATE` in the service. It is here instead,
 * because every service in this module is Prisma-free by construction and
 * opening a transaction from one would mean threading a transaction
 * abstraction through this port. The guarantee is identical; only the file
 * differs. The service still owns the *policy* — whether the post is visible to
 * this actor at all — and this owns the *atomicity*.
 *
 * Returns `null` when the parent is absent, rather than throwing, because
 * "post is gone" is an ordinary outcome the service turns into
 * `ContentUnavailableError` alongside the hidden, deleted and blocked cases
 * that must stay indistinguishable from it.
 */
export interface CommentRepository {
  /**
   * Inserts and increments `commentCount` in one transaction.
   *
   * `null` means the post row was not there when the lock was taken.
   */
  insert(input: {
    postId: string;
    authorId: string;
    content: string;
    dateCreated: Date;
  }): Promise<StoredComment | null>;

  /** Oldest first — a thread reads top to bottom, unlike a feed. */
  list(query: ListCommentsQuery): Promise<readonly StoredComment[]>;

  /**
   * One comment, or `null` if the caller may not see it.
   *
   * **The same three predicates as the thread list and as
   * {@link PostReader.findVisibleById}** — not deleted, not hidden, not by a
   * block counterpart — and the four reasons for `null` stay one return value
   * for the same reason they do on a post: a caller who can tell "hidden" from
   * "absent" can probe ids to map them onto people they have blocks with
   * (spec §7.2).
   *
   * **The thread applies a fourth gate that this does not.** `CommentService.list`
   * reads the parent post first, so a comment under a hidden or deleted post is
   * absent from the thread entirely, while here it still returns. That is
   * acceptable: the block filter is applied on the comment's own author, so the
   * §7.2 probe stays closed, and the one bit that differs — that the comment id
   * still exists under a post the caller can no longer read — tells the
   * reporter nothing about the parent. A report on such a comment is still
   * evidence worth keeping.
   */
  findVisibleById(
    commentId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredComment | null>;

  /**
   * Sets `hiddenAt`, once. Returns whether a row moved. The same contract as
   * {@link PostRepository.hide}: idempotent, first hide wins, row kept.
   */
  hide(commentId: string, hiddenAt: Date): Promise<boolean>;

  /**
   * Clears `hiddenAt`. Returns whether a row moved. The same contract as
   * {@link PostRepository.unhide}: idempotent, `false` for a visible or absent
   * row.
   */
  unhide(commentId: string): Promise<boolean>;

  /**
   * Rewrites an author's own comment body, returning the updated row or `null`
   * if nothing matched.
   *
   * The predicate carries `authorId`, `hiddenAt IS NULL` and
   * `deletedAt IS NULL` for the reasons {@link PostRepository.editByAuthor}
   * gives. It does **not** check the parent post: the service resolves that
   * first, because a comment on a hidden post must refuse for the parent's
   * reason and a repository that joined to find out would be answering a
   * visibility question the service owns.
   */
  editByAuthor(input: {
    commentId: string;
    authorId: string;
    content: string;
    editedAt: Date;
  }): Promise<StoredComment | null>;

  /**
   * Sets `deletedAt` on an author's own comment and decrements the parent's
   * `commentCount`, atomically. Returns whether a row moved.
   *
   * **The counter moves with the row, in one transaction** — spec §9.2.1 and
   * §9.2.5: `commentCount` counts non-deleted comments, so a soft delete that
   * left it alone would overstate every thread it touched. The decrement is
   * relative (`comment_count - 1`), never a read-modify-write, and is
   * **floored at zero** (§9.2.4) so that drift from a purge or a manual edit
   * can never render as a negative.
   *
   * **`false` means nothing was deleted and nothing was decremented.** The two
   * must not come apart: a second delete that refused but still decremented
   * would walk the counter down on every retry.
   */
  softDeleteByAuthor(input: {
    commentId: string;
    authorId: string;
    deletedAt: Date;
  }): Promise<boolean>;
}

/**
 * Which of these posts the viewer has already upvoted.
 *
 * **Declared by `content`, implemented by `engagement`.** The feed needs vote
 * state and the vote path needs post visibility, so a direct dependency either
 * way would close a cycle between the two modules. Content declaring the shape
 * it needs — and `composition.ts` supplying `engagement`'s repository as the
 * implementation — is the §3.2 rule applied in the one direction that stays
 * acyclic.
 *
 * Empty input must not become a query: the feed calls this on every page,
 * including empty ones.
 */
export interface ViewerVoteReader {
  votedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

/**
 * Which of these posts the viewer has saved.
 *
 * **Declared by `content`, implemented by `engagement`**, for the same reason
 * as {@link ViewerVoteReader} and under the same §3.2 rule: the feed needs
 * save state and the save path needs post visibility, so a direct dependency
 * either way would close a cycle. `composition.ts` is the one file that knows
 * both modules exist.
 *
 * Empty input must not become a query.
 */
export interface ViewerSaveReader {
  savedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

/**
 * Several posts at once, filtered exactly as the feed filters.
 *
 * The saved list reads bookmark rows out of `engagement` and then needs the
 * posts behind them, so it hands the ids here rather than calling
 * {@link PostReader.findVisibleById} once per row.
 */
export interface PostBatchReader {
  /**
   * The subset of `postIds` the caller may see, in no particular order.
   *
   * **Shorter than its input is the ordinary case, not an error.** A saved row
   * outlives the post it points at — deleted, moderator-hidden, or authored by
   * someone the viewer has since blocked — and the same three-way collapse
   * that makes those indistinguishable one at a time makes them simply absent
   * in bulk.
   */
  findVisibleByIds(
    postIds: readonly string[],
    excludeAuthorIds: readonly string[],
  ): Promise<readonly StoredPost[]>;
}
