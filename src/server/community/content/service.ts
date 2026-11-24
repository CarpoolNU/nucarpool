import type { CommunityActor, Member } from "../actor";
import type { CommunityHostPort } from "../host/CommunityHostPort";
import type { ProfileReader } from "../identity/ports";
import { requireVisibleProfile } from "../identity/visibleProfile";
import {
  CategoryUnknownError,
  ContentUnavailableError,
  NotAuthorError,
} from "../shared/errors";
import {
  decodeCursor,
  encodeCursor,
  type Cursor,
  type SortKey,
} from "../shared/cursor";
import { clampPageSize } from "../shared/paging";
import { normalizeSearchTerm } from "./domain/searchTerm";
import {
  COMMENT_CONTENT_MAX_LENGTH,
  POST_CONTENT_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  requireBoundedText,
} from "./domain/textLimits";
import type {
  CategoryRepository,
  CommentRepository,
  PostRepository,
  StoredCategory,
  StoredComment,
  StoredPost,
  ViewerSaveReader,
  ViewerVoteReader,
} from "./ports";
import {
  toPublicCategory,
  toPublicComment,
  toPublicPost,
  type PublicCategory,
  type PublicComment,
  type PublicPost,
  type PublicPostReader,
} from "./public";

export type PostPage = {
  posts: PublicPost[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
};

/**
 * Reading and writing posts.
 *
 * **The feed reads in two orders, New and Top**, each a keyset page over its
 * own index tuple — `(dateCreated, id)` and `(voteCount, id)`. New is the
 * default, so a caller that names no sort keeps the behaviour it had before
 * Top existed.
 */
export class PostService implements PublicPostReader {
  /**
   * `votes` and `saves` are optional, and that is deliberate rather than lazy.
   *
   * Both are the `engagement` module's repository arriving through an
   * interface `content` declares, so a composition without an engagement
   * module — which is what every `content` test that does not care about
   * either uses — still constructs. When one is absent every post reports
   * `false` for it, which is the truth in a build where nobody can do it.
   */
  constructor(
    private readonly posts: PostRepository,
    private readonly categories: CategoryRepository,
    private readonly profiles: ProfileReader,
    private readonly host: CommunityHostPort,
    private readonly votes?: ViewerVoteReader,
    private readonly saves?: ViewerSaveReader,
  ) {}

  async listCategories(): Promise<PublicCategory[]> {
    const rows = await this.categories.listActive();
    return rows.map(toPublicCategory);
  }

  async create(
    actor: Member,
    input: { categorySlug: string; title: string; content: string },
  ): Promise<PublicPost> {
    // Bound the text before resolving anything: it is pure, and it is the
    // failure a composer hits most often.
    const title = requireBoundedText(
      "Title",
      input.title,
      POST_TITLE_MAX_LENGTH,
    );
    const content = requireBoundedText(
      "Post",
      input.content,
      POST_CONTENT_MAX_LENGTH,
    );

    const category = await this.requireCategory(input.categorySlug, {
      mustBeActive: true,
    });

    const stored = await this.posts.insert({
      authorId: actor.userId,
      categoryId: category.id,
      title,
      content,
      dateCreated: this.host.now(),
    });

    // The author's handle is already on the actor, so creating a post costs no
    // profile lookup — and `viewerIsAuthor` is true by construction here, since
    // the only caller that can reach this line is the one that just wrote it.
    return toPublicPost(
      stored,
      category.slug,
      actor.profile.handle,
      false,
      false,
      true,
    );
  }

  /**
   * Rewrites the author's own title and body.
   *
   * **The category does not move.** Spec §2 scopes an edit to the text, and
   * re-categorising is a different act: a post gathers votes, comments and
   * saves inside a category, and letting it change would move that history
   * under readers who found it there. Nothing here forecloses it later.
   *
   * **Two checks, and they answer different questions.** The read collapses
   * unknown/deleted/hidden/blocked into `CONTENT_UNAVAILABLE` exactly as
   * {@link byId} does, so an edit cannot be used to probe which ids exist. The
   * author comparison then raises `NOT_AUTHOR` — FORBIDDEN rather than
   * NOT_FOUND, and that is not a leak: the post was already visible to this
   * caller a line earlier, so the code confirms nothing they could not read in
   * the feed.
   *
   * **The repository predicate is the arbiter, not this read.** A moderator can
   * hide the post between the read and the write; `editByAuthor` returns `null`
   * when that happens and the refusal below is the same one every other
   * unavailable case gets.
   */
  async edit(
    actor: Member,
    input: { postId: string; title: string; content: string },
  ): Promise<PublicPost> {
    // Bound the text first, as `create` does: pure, no I/O, and the failure an
    // editor hits most often.
    const title = requireBoundedText(
      "Title",
      input.title,
      POST_TITLE_MAX_LENGTH,
    );
    const content = requireBoundedText(
      "Post",
      input.content,
      POST_CONTENT_MAX_LENGTH,
    );

    await this.requireOwnPost(actor, input.postId);

    const updated = await this.posts.editByAuthor({
      postId: input.postId,
      authorId: actor.userId,
      title,
      content,
      editedAt: this.host.now(),
    });

    if (!updated) {
      throw new ContentUnavailableError();
    }

    const [hydrated] = await this.hydrate(actor.userId, [updated]);
    return hydrated!;
  }

  /**
   * Sets `deletedAt` on the author's own post.
   *
   * **Soft, and the row stays** (spec §6.4, §8): a report filed against this
   * post still has its target, the comment-orphan hazard never forms, and the
   * counters stay reconcilable. Nothing in Community hard-deletes a post.
   *
   * **A second delete refuses rather than succeeding quietly.** `save`/`unsave`
   * and `vote`/`unvote` are idempotent because a retried request must not
   * invert an intent; delete has no inverse to be flipped into, so the honest
   * answer to "delete this post" when it is already gone is that it is gone.
   */
  async delete(actor: Member, input: { postId: string }): Promise<void> {
    await this.requireOwnPost(actor, input.postId);

    const deleted = await this.posts.softDeleteByAuthor({
      postId: input.postId,
      authorId: actor.userId,
      deletedAt: this.host.now(),
    });

    if (!deleted) {
      throw new ContentUnavailableError();
    }
  }

  /**
   * Resolves a post the actor may change, or refuses.
   *
   * **The block list is still consulted**, even though a post's own author can
   * never be a block counterpart of theirs. Passing `[]` instead would be a
   * second, laxer definition of "visible" living next to the one every read
   * path uses, and the next method to reuse this helper would inherit it.
   */
  private async requireOwnPost(
    actor: Member,
    postId: string,
  ): Promise<StoredPost> {
    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(
      actor.userId,
    );
    const post = await this.posts.findVisibleById(postId, excludeAuthorIds);
    if (!post) {
      throw new ContentUnavailableError();
    }
    if (post.authorId !== actor.userId) {
      throw new NotAuthorError();
    }
    return post;
  }

  /**
   * One page of the feed.
   *
   * **A Top page can repeat or miss a post, and that is inherent rather than a
   * bug here.** `voteCount` is the column being paged over and it moves while
   * a reader pages: a post that gains a vote after the reader passes it can
   * reappear on a later page, and one that loses a vote can slip behind the
   * cursor unseen. Keyset paging over a mutable sort column has no fix short
   * of a snapshot of the ordering, which a feed this size does not justify.
   * The New feed does not have this problem because `dateCreated` never moves.
   */
  async list(
    actor: CommunityActor,
    input: {
      categorySlug?: string;
      /**
       * A substring to look for in the title or the content.
       *
       * **Search is a narrowing of the feed, not a list of its own** (SCRUM-683).
       * It is the same method because it must hide the same things: a search
       * that forgot `hiddenAt` would turn the moderation queue into an index of
       * what had been hidden, and one that forgot the block filter would show
       * a reader exactly the author they blocked. One query, one answer.
       */
      search?: string;
      sort?: SortKey;
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<PostPage> {
    const limit = clampPageSize(input.limit);
    const sort = input.sort ?? "new";
    // Trimmed, bounded, and `null` when there is nothing to search for — done
    // before any I/O, as the text checks on the write path are.
    const search = normalizeSearchTerm(input.search);

    let categoryId: string | null = null;
    if (input.categorySlug !== undefined) {
      // `mustBeActive: false`: a retired category stays browsable. See
      // {@link requireCategory} for why the read and write paths differ.
      const category = await this.requireCategory(input.categorySlug, {
        mustBeActive: false,
      });
      categoryId = category.id;
    }

    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(
      actor.userId,
    );

    // One more row than the page, so "is there another page?" is answered
    // without a second query and without a COUNT over the whole category.
    const rows = await this.posts.list({
      categoryId,
      search,
      sort,
      // Decoding against `sort` is what makes a cursor from the other feed a
      // restart rather than a vote count read as a date (spec §10).
      after: input.cursor ? decodeCursor(input.cursor, sort) : null,
      limit: limit + 1,
      excludeAuthorIds,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const posts = await this.hydrate(actor.userId, page);

    const last = page[page.length - 1];
    return {
      posts,
      nextCursor: hasMore && last ? encodeCursor(postCursor(sort, last)) : null,
    };
  }

  /**
   * One post, for the detail page.
   *
   * **Refuses with `ContentUnavailableError` rather than returning `null`**,
   * because transport maps that to NOT_FOUND — and the four reasons a post is
   * unavailable must stay indistinguishable (spec §7.2). A `null` return would
   * invite a caller to render "this post was removed", which tells a blocked
   * user that the post exists.
   */
  async byId(actor: CommunityActor, postId: string): Promise<PublicPost> {
    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(
      actor.userId,
    );
    const post = await this.posts.findVisibleById(postId, excludeAuthorIds);
    if (!post) {
      throw new ContentUnavailableError();
    }

    const [hydrated] = await this.hydrate(actor.userId, [post]);
    // One row in, one row out: `findVisibleById` has already refused every
    // case that could drop it.
    return hydrated!;
  }

  /**
   * One page of a handle's own posts, newest first.
   *
   * **The profile's list, served from `content` rather than from `identity`.**
   * A profile view needs a handle resolved and then a post list; `content`
   * already depends on `identity` for the handles it renders on every post, so
   * doing the resolution on this side keeps that dependency running one way.
   * Having `identity` reach back for posts would close a cycle between the two
   * modules.
   *
   * **The handle never becomes a user id the caller can see.** It is resolved
   * here, used as a `WHERE` predicate, and discarded — which is what keeps
   * spec §13.4's "no procedure maps handle → userId for a non-moderator" true
   * of a page whose entire purpose is to list one user's posts.
   *
   * **`Member`, not `CommunityActor`**, for the reason `ProfileService.byHandle`
   * gives: gathering one person's output is a different capability from
   * reading a feed, and the viewer being identifiable in the same way as the
   * author is the justification for offering it at all.
   *
   * **Posts only. Comments are deliberately not listed here, and no method
   * lists them.** A comment history is a far stronger aggregation than a post
   * history — it reconstructs which threads someone was in and when, across
   * the whole board — and the decision to leave it out is recorded here so
   * that adding it later is a decision somebody makes rather than a gap
   * somebody fills.
   *
   * **Newest first only.** There is no Top order for a profile: ranking one
   * person's posts against each other is a question nobody asked, and a second
   * ordering would need a second index for it.
   */
  async listByHandle(
    actor: Member,
    input: { handle: string; cursor?: string; limit?: number },
  ): Promise<PostPage> {
    const limit = clampPageSize(input.limit);

    // Refuses before any post is read — and refuses identically whether the
    // handle is unclaimed, unclaimable, or one the viewer has a block with.
    // An empty list would tell a blocked reader the handle exists.
    const { profile } = await requireVisibleProfile(
      this.profiles,
      this.host,
      actor.userId,
      input.handle,
    );

    // One more row than the page, so "is there another page?" costs no second
    // query. A stale or cross-sort cursor decodes to `null` and restarts the
    // list, which is a mild surprise rather than a broken page.
    const rows = await this.posts.listByAuthor({
      authorId: profile.userId,
      after: input.cursor ? decodeCursor(input.cursor, "new") : null,
      limit: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const posts = await this.hydrate(actor.userId, page);

    const last = page[page.length - 1];
    return {
      posts,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sort: "new",
              dateCreated: last.dateCreated,
              id: last.id,
            })
          : null,
    };
  }

  /**
   * The posts behind a set of ids, in the order they were asked for.
   *
   * **This is the saved list's view of `content`**, and the reason it is a
   * method here rather than a query there: the three-way visibility rule, the
   * author handles, the category slugs and the viewer's own vote and save
   * state are all assembled in one place, so a second list cannot drift from
   * the feed in what it shows or what it hides.
   */
  async visibleByIds(
    actor: CommunityActor,
    postIds: readonly string[],
  ): Promise<readonly PublicPost[]> {
    if (postIds.length === 0) {
      return [];
    }

    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(
      actor.userId,
    );
    const rows = await this.posts.findVisibleByIds(postIds, excludeAuthorIds);

    // Re-impose the caller's order. The repository answers a set membership
    // question and has no reason to know what order the ids arrived in — on
    // the saved list that order is "when you saved it", which no column on
    // `community_post` records.
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = postIds
      .map((id) => byId.get(id))
      .filter((row): row is StoredPost => row !== undefined);

    return this.hydrate(actor.userId, ordered);
  }

  /**
   * Turns stored rows into the public shape, in one pass of lookups.
   *
   * Shared by every read path so that "what a post looks like to a viewer" is
   * answered once — the alternative is three call sites that each remember to
   * fetch handles, slugs, vote state and save state, until one of them does
   * not.
   */
  private async hydrate(
    userId: string,
    rows: readonly StoredPost[],
  ): Promise<PublicPost[]> {
    const postIds = rows.map((row) => row.id);

    const [handles, slugs, voted, saved] = await Promise.all([
      this.profiles.findManyByUserIds([
        ...new Set(rows.map((r) => r.authorId)),
      ]),
      this.categorySlugsById(rows.map((r) => r.categoryId)),
      this.votedPostIds(userId, postIds),
      this.savedPostIds(userId, postIds),
    ]);

    return rows.map((row) =>
      toPublicPost(
        row,
        // The map is built from these very rows, so a miss means the
        // category row itself is gone — there is no foreign key to stop that
        // under `relationMode = "prisma"`. A blank pill is the right answer to
        // a label that no longer exists anywhere; it used to be the answer to
        // a label that did (SCRUM-690).
        slugs.get(row.categoryId) ?? "",
        handles.get(row.authorId)?.handle,
        voted.has(row.id),
        saved.has(row.id),
        row.authorId === userId,
      ),
    );
  }

  /**
   * Which of these posts the caller has upvoted.
   *
   * **Short-circuits on an empty page**, because the feed reaches here on every
   * request including the ones with nothing in them, and `WHERE post_id IN ()`
   * is a query that can only return nothing.
   */
  private async votedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (!this.votes || postIds.length === 0) {
      return new Set();
    }
    return this.votes.votedPostIds(userId, postIds);
  }

  /** Which of these posts the caller has saved. Short-circuits as votes do. */
  private async savedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (!this.saves || postIds.length === 0) {
      return new Set();
    }
    return this.saves.savedPostIds(userId, postIds);
  }

  /**
   * Resolves a slug to its category, or refuses with `CategoryUnknownError`.
   *
   * **`mustBeActive` is the one thing the read and write paths disagree on,
   * and it is a parameter so that the disagreement is stated at both call
   * sites rather than inherited** (SCRUM-690). `create` passes `true`: nothing
   * new may be written to a retired category, which is what retiring is for.
   * `list` passes `false`: a link or a bookmark naming a retired category
   * keeps working, and its posts stay reachable the same way they stay
   * readable. The retired category is still never *offered* — the composer's
   * picker and the feed's chips both come from `listCategories`, which is
   * `listActive`.
   *
   * A retired category is unknown rather than forbidden on the write path, so
   * the refusal is the same one an invented slug gets.
   */
  private async requireCategory(
    slug: string,
    { mustBeActive }: { mustBeActive: boolean },
  ): Promise<StoredCategory> {
    const category = await this.categories.findBySlug(slug);
    if (!category || (mustBeActive && !(await this.isActive(category)))) {
      throw new CategoryUnknownError(slug);
    }
    return category;
  }

  private async isActive(category: StoredCategory): Promise<boolean> {
    const active = await this.categories.listActive();
    return active.some((row) => row.id === category.id);
  }

  /**
   * Slugs for the categories these posts are in — **the ones on the page, not
   * the ones on offer.**
   *
   * Built from `listActive()` until SCRUM-690, which meant a post whose
   * category had been retired resolved to nothing and rendered an empty pill.
   * Asking by id instead makes the map total over the page by construction.
   *
   * Short-circuits on an empty page, as the vote and save lookups do: the feed
   * reaches here on every request, including the ones with nothing in them.
   */
  private async categorySlugsById(
    categoryIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const ids = [...new Set(categoryIds)];
    if (ids.length === 0) {
      return new Map();
    }
    const rows = await this.categories.findManyByIds(ids);
    return new Map(rows.map((row) => [row.id, row.slug]));
  }
}

export type CommentPage = {
  comments: PublicComment[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
};

/**
 * Reading and writing the comments on a post.
 *
 * **The service owns visibility; the repository owns atomicity.** Every method
 * here starts by resolving the parent post through `findVisibleById`, which
 * collapses unknown/deleted/hidden/blocked into a single `null` — so a caller
 * cannot tell a moderator-hidden post from one that never existed (spec §7.2).
 * The insert's race against a hard delete is a separate concern, handled by the
 * transaction inside `CommentRepository.insert`; see its doc comment for why it
 * lives there rather than here.
 */
export class CommentService {
  constructor(
    private readonly comments: CommentRepository,
    private readonly posts: PostRepository,
    private readonly profiles: ProfileReader,
    private readonly host: CommunityHostPort,
  ) {}

  async create(
    actor: Member,
    input: { postId: string; content: string },
  ): Promise<PublicComment> {
    // Bound the text first: it is pure, it needs no I/O, and it is the failure
    // a composer hits most often.
    const content = requireBoundedText(
      "Comment",
      input.content,
      COMMENT_CONTENT_MAX_LENGTH,
    );

    await this.requireVisiblePost(actor.userId, input.postId);

    const stored = await this.comments.insert({
      postId: input.postId,
      authorId: actor.userId,
      content,
      dateCreated: this.host.now(),
    });

    // `null` means the post vanished between the visibility check and the
    // lock — the §6.2 race, losing. It is reported as the same refusal as every
    // other reason the post is not there.
    if (!stored) {
      throw new ContentUnavailableError();
    }

    // The handle is already on the actor, so replying costs no profile lookup;
    // `viewerIsAuthor` is true by construction, as in `PostService.create`.
    return toPublicComment(stored, actor.profile.handle, true);
  }

  /**
   * Rewrites the author's own comment body.
   *
   * **Three refusals, in the order a reader would want them.** The text bound
   * is pure and comes first. Then the comment itself must resolve — unknown,
   * deleted, hidden and blocked-author all collapse to `CONTENT_UNAVAILABLE`,
   * as everywhere else — and then its parent post must resolve too, because a
   * thread a moderator has hidden is closed to its participants as well as to
   * its readers. `NOT_AUTHOR` is last, and is FORBIDDEN rather than NOT_FOUND
   * for {@link PostService.edit}'s reason: the comment was readable to this
   * caller a line earlier.
   */
  async edit(
    actor: Member,
    input: { commentId: string; content: string },
  ): Promise<PublicComment> {
    const content = requireBoundedText(
      "Comment",
      input.content,
      COMMENT_CONTENT_MAX_LENGTH,
    );

    await this.requireOwnComment(actor, input.commentId);

    const updated = await this.comments.editByAuthor({
      commentId: input.commentId,
      authorId: actor.userId,
      content,
      editedAt: this.host.now(),
    });

    // `null` is a moderator's hide landing between the check and the write —
    // reported as the same refusal as every other unavailable case.
    if (!updated) {
      throw new ContentUnavailableError();
    }

    return toPublicComment(updated, actor.profile.handle, true);
  }

  /**
   * Sets `deletedAt` on the author's own comment and takes the parent's
   * `commentCount` down with it.
   *
   * **The counter is the repository's job, in the same transaction as the
   * row** (spec §9.2.1). The service does not read it, decrement it, or write
   * it back: a read-modify-write here would lose a concurrent reply's
   * increment, and the two statements could not be made to commit together
   * from this layer anyway.
   */
  async delete(actor: Member, input: { commentId: string }): Promise<void> {
    await this.requireOwnComment(actor, input.commentId);

    const deleted = await this.comments.softDeleteByAuthor({
      commentId: input.commentId,
      authorId: actor.userId,
      deletedAt: this.host.now(),
    });

    if (!deleted) {
      throw new ContentUnavailableError();
    }
  }

  /**
   * Resolves a comment the actor may change, or refuses.
   *
   * **It resolves the parent post as well**, and not only for tidiness: a
   * comment carries no category and no visibility of its own beyond its flags,
   * so the post is the only thing that can say whether this thread is still
   * open. Checking the comment alone would let someone keep editing their
   * replies inside a thread a moderator had already hidden.
   */
  private async requireOwnComment(
    actor: Member,
    commentId: string,
  ): Promise<StoredComment> {
    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(
      actor.userId,
    );
    const comment = await this.comments.findVisibleById(
      commentId,
      excludeAuthorIds,
    );
    if (!comment) {
      throw new ContentUnavailableError();
    }

    // Refuses for the parent's reason before it refuses for the author's, so a
    // hidden thread reads the same to a participant as to anyone else.
    await this.requireVisiblePost(actor.userId, comment.postId);

    if (comment.authorId !== actor.userId) {
      throw new NotAuthorError();
    }
    return comment;
  }

  async list(
    actor: CommunityActor,
    input: { postId: string; cursor?: string; limit?: number },
  ): Promise<CommentPage> {
    const limit = clampPageSize(input.limit);
    const excludeAuthorIds = await this.requireVisiblePost(
      actor.userId,
      input.postId,
    );

    // One more row than the page, so "is there another page?" needs no COUNT.
    const rows = await this.comments.list({
      postId: input.postId,
      after: input.cursor ? decodeCursor(input.cursor, "new") : null,
      limit: limit + 1,
      excludeAuthorIds,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const handles = await this.profiles.findManyByUserIds([
      ...new Set(page.map((row) => row.authorId)),
    ]);

    const last = page[page.length - 1];
    return {
      comments: page.map((row) =>
        toPublicComment(
          row,
          handles.get(row.authorId)?.handle,
          row.authorId === actor.userId,
        ),
      ),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sort: "new",
              dateCreated: last.dateCreated,
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Resolves the parent post or refuses, returning the block list the caller
   * will need next.
   *
   * Returning `excludeAuthorIds` rather than discarding it keeps the thread
   * read to one block lookup: the same list that decided whether the post is
   * visible also filters the comments on it.
   */
  private async requireVisiblePost(
    userId: string,
    postId: string,
  ): Promise<readonly string[]> {
    const excludeAuthorIds = await this.host.getBlockedCounterpartIds(userId);
    const post = await this.posts.findVisibleById(postId, excludeAuthorIds);
    if (!post) {
      throw new ContentUnavailableError();
    }
    return excludeAuthorIds;
  }
}

/**
 * The keyset position of the last row on a page, in whichever order produced
 * it.
 *
 * Minting the cursor from the sort that produced the page — rather than from
 * whatever the next request asks for — is what the decoder's cross-sort
 * refusal has to check against.
 */
const postCursor = (sort: SortKey, post: StoredPost): Cursor =>
  sort === "top"
    ? { sort: "top", voteCount: post.voteCount, id: post.id }
    : { sort: "new", dateCreated: post.dateCreated, id: post.id };
