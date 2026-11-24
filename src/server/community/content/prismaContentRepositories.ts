import { escapeLikeWildcards } from "./domain/searchTerm";
import type {
  CategoryRepository,
  CommentRepository,
  ListAuthoredPostsQuery,
  ListCommentsQuery,
  ListPostsQuery,
  PostRepository,
  StoredCategory,
  StoredComment,
  StoredPost,
} from "./ports";

/**
 * Narrow Prisma surfaces, declared structurally so this module typechecks
 * before `prisma generate` has seen `community.prisma`. Both the base client
 * and a transaction client satisfy them.
 */
export type CategoryStore = {
  communityCategory: {
    findUnique(args: {
      where: { slug: string };
    }): Promise<StoredCategory | null>;
    // Two reads, one method: the offer, which is ordered and filtered by
    // `isActive`, and the label lookup by id, which is neither (SCRUM-690).
    findMany(args: {
      where: { isActive: boolean } | { id: { in: string[] } };
      orderBy?: { sortOrder: "asc" };
    }): Promise<StoredCategory[]>;
  };
};

/**
 * The post delegate as seen from inside a transaction.
 *
 * Split out from {@link PostStore} for the reason {@link CommentTxStore} is: a
 * Prisma transaction client carries the delegates but **not** `$transaction`,
 * so one type covering both would claim a nested transaction is available when
 * it is not.
 */
export type PostTxStore = {
  communityPost: {
    create(args: { data: Record<string, unknown> }): Promise<StoredPost>;
    findMany(args: Record<string, unknown>): Promise<StoredPost[]>;
    findFirst(args: Record<string, unknown>): Promise<StoredPost | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

export type PostStore = PostTxStore & {
  $transaction<T>(run: (tx: PostTxStore) => Promise<T>): Promise<T>;
};

/**
 * The delegates a comment insert touches, as seen from inside a transaction.
 *
 * Declared apart from {@link CommentStore} because a Prisma transaction client
 * has the delegates and `$queryRawUnsafe` but **not** `$transaction` — so a
 * single type covering both would claim a nested transaction is available when
 * it is not.
 */
export type CommentTxStore = {
  communityComment: {
    create(args: { data: Record<string, unknown> }): Promise<StoredComment>;
    findMany(args: Record<string, unknown>): Promise<StoredComment[]>;
    findFirst(args: Record<string, unknown>): Promise<StoredComment | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  communityPost: {
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    /**
     * Needed for the *guarded* decrement a soft delete does. `update` cannot
     * express it: the floor at zero is a predicate on `comment_count`, and
     * `update` takes only a unique `where`.
     */
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  /**
   * Raw SQL, for the one statement Prisma cannot express.
   *
   * **"Unsafe" names the query string, not the values.** The `?` placeholders
   * are bound by the driver exactly as any other parameter, so this is not an
   * injection site; what is unchecked is that the SQL itself is valid, which is
   * the price of `FOR UPDATE` having no Prisma equivalent.
   */
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

export type CommentStore = CommentTxStore & {
  $transaction<T>(run: (tx: CommentTxStore) => Promise<T>): Promise<T>;
};

/**
 * Locks a post row and reports whether it is there.
 *
 * **`FOR UPDATE`, and it is not pedantry.** `src/server/db/blocks.ts` documents
 * the reason this module copies: a plain `SELECT` inside an interactive
 * transaction answers from that transaction's REPEATABLE READ snapshot, so a
 * row another transaction commits afterwards stays invisible for the rest of
 * this one. `FOR UPDATE` forces a current read and holds a lock the competing
 * writer must queue behind — which is what closes the window in which a post is
 * deleted between "does it exist" and "insert the child" (spec §6.2).
 *
 * **Raw column names, not Prisma field names**, because raw SQL bypasses
 * Prisma's `@map`ping entirely. `community_post`, not `communityPost`.
 */
export const lockPostForUpdate = async (
  tx: CommentTxStore,
  postId: string,
): Promise<boolean> => {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    "SELECT `id` FROM `community_post` WHERE `id` = ? FOR UPDATE",
    postId,
  );
  return rows.length > 0;
};

/**
 * The `title OR content` half of a search, as a fragment of a `where`.
 *
 * **It is nested under `AND` rather than returning a bare `OR`, and that is
 * load-bearing rather than tidy.** The keyset cursor in
 * {@link PrismaPostRepository.list} is itself a top-level `OR`, and the two are
 * merged into one object literal by spreading: a second `OR` key would replace
 * the first outright. Whichever lost would vanish silently — a dropped cursor
 * restarts the list from the top on every "Load more", and a dropped search
 * returns the whole feed as though it matched. Both are wrong in a way no type
 * catches, so the search goes somewhere the cursor is not.
 *
 * **`contains` with the wildcards escaped**, never the raw term: see
 * {@link escapeLikeWildcards} for what Prisma does and does not do with a `%`
 * inside a bound value.
 */
const searchFilter = (search: string | null): Record<string, unknown> => {
  if (search === null) {
    return {};
  }
  const term = escapeLikeWildcards(search);
  return {
    AND: [
      { OR: [{ title: { contains: term } }, { content: { contains: term } }] },
    ],
  };
};

export class PrismaCategoryRepository implements CategoryRepository {
  constructor(private readonly store: CategoryStore) {}

  async findBySlug(slug: string): Promise<StoredCategory | null> {
    return this.store.communityCategory.findUnique({ where: { slug } });
  }

  async findManyByIds(
    ids: readonly string[],
  ): Promise<readonly StoredCategory[]> {
    // No `isActive` predicate: a post outlives its category's retirement and
    // still needs the label (SCRUM-690). The primary key serves this.
    return this.store.communityCategory.findMany({
      where: { id: { in: [...ids] } },
    });
  }

  async listActive(): Promise<readonly StoredCategory[]> {
    return this.store.communityCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
    });
  }
}

export class PrismaPostRepository implements PostRepository {
  constructor(private readonly store: PostStore) {}

  async insert(input: {
    authorId: string;
    categoryId: string;
    title: string;
    content: string;
    dateCreated: Date;
  }): Promise<StoredPost> {
    return this.store.communityPost.create({ data: input });
  }

  /**
   * One post, filtered exactly as the feed filters.
   *
   * **The same three predicates as `list`, plus the id.** That is the point:
   * a post absent from the feed must also be absent here, or the detail route
   * becomes a way to read what the feed declined to show — including a post by
   * someone the caller has a block with.
   *
   * `findFirst` rather than `findUnique`, because the filter is more than the
   * primary key and `findUnique` accepts only unique fields.
   */
  async findVisibleById(
    postId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredPost | null> {
    return this.store.communityPost.findFirst({
      where: {
        id: postId,
        deletedAt: null,
        hiddenAt: null,
        ...(excludeAuthorIds.length > 0
          ? { authorId: { notIn: [...excludeAuthorIds] } }
          : {}),
      },
    });
  }

  /**
   * The same filter as {@link findVisibleById}, over a set of ids.
   *
   * **One query for a page of saves, not one per row.** The saved list holds
   * post ids and needs the posts; asking row by row would make a twenty-row
   * page twenty round trips, each with the same three predicates.
   *
   * No ordering is imposed. `IN` has no meaningful order of its own and the
   * caller's order — on the saved list, when each post was saved — is not a
   * column on this table, so the caller re-imposes it.
   */
  async findVisibleByIds(
    postIds: readonly string[],
    excludeAuthorIds: readonly string[],
  ): Promise<readonly StoredPost[]> {
    if (postIds.length === 0) {
      return [];
    }

    return this.store.communityPost.findMany({
      where: {
        id: { in: [...postIds] },
        deletedAt: null,
        hiddenAt: null,
        ...(excludeAuthorIds.length > 0
          ? { authorId: { notIn: [...excludeAuthorIds] } }
          : {}),
      },
    });
  }

  /**
   * The feed query, in either order.
   *
   * **Keyset, not offset.** The `OR` below is the tuple comparison
   * `(key, id) < (cursor.key, cursor.id)` written the way Prisma can express
   * it, where `key` is `dateCreated` on New and `voteCount` on Top. Each is
   * served by one of the index tuples declared in `community.prisma`:
   * `@@index([categoryId, dateCreated, id])` and
   * `@@index([categoryId, voteCount, id])`.
   *
   * The trailing `id` in both the filter and the ordering is load-bearing.
   * On New it covers posts created in the same millisecond; on Top it covers
   * the ordinary case, since most posts share a small vote count and without
   * it the feed would re-permute between pages.
   *
   * **The Top ordering is over a column that moves.** A post whose count
   * changes mid-page can be served twice or skipped; see `PostService.list`
   * for why that is accepted rather than fixed here.
   *
   * `hiddenAt` and `deletedAt` are both excluded here, which is why a
   * moderator-hidden post and an author-deleted post are indistinguishable to
   * a reader — as is a post excluded by `excludeAuthorIds`, the block filter.
   *
   * **A search term narrows this query rather than getting one of its own.**
   * Everything the feed hides, a search must hide too — hidden, deleted and
   * blocked-author rows alike — and the cheapest way to guarantee that is for
   * there to be one `WHERE` clause rather than two that have to be kept in
   * step. The cost is that the search inherits an ordering no index can serve
   * once the `LIKE` is present; see {@link ListPostsQuery.search}.
   */
  async list(query: ListPostsQuery): Promise<readonly StoredPost[]> {
    const after = query.after;
    const top = query.sort === "top";

    return this.store.communityPost.findMany({
      where: {
        deletedAt: null,
        hiddenAt: null,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...searchFilter(query.search),
        ...(query.excludeAuthorIds.length > 0
          ? { authorId: { notIn: [...query.excludeAuthorIds] } }
          : {}),
        ...(after
          ? after.sort === "top"
            ? {
                OR: [
                  { voteCount: { lt: after.voteCount } },
                  { voteCount: after.voteCount, id: { lt: after.id } },
                ],
              }
            : {
                OR: [
                  { dateCreated: { lt: after.dateCreated } },
                  { dateCreated: after.dateCreated, id: { lt: after.id } },
                ],
              }
          : {}),
      },
      orderBy: top
        ? [{ voteCount: "desc" }, { id: "desc" }]
        : [{ dateCreated: "desc" }, { id: "desc" }],
      take: query.limit,
    });
  }

  /**
   * The profile list: one author's posts, newest first.
   *
   * **Served by `@@index([authorId, dateCreated, id])`**, which
   * `community.prisma` declares for this query and nothing else. The
   * single-column `@@index([authorId])` it replaced was there to satisfy
   * Prisma's emulated referential integrity under `relationMode = "prisma"`;
   * it would have narrowed to the author and then filesorted every one of
   * their posts on every page — degrading exactly for the prolific authors a
   * profile page exists to surface. `authorId` is still the leftmost column,
   * so the referential-integrity use is unaffected.
   *
   * The `OR` is the same tuple comparison the feed uses, and the trailing `id`
   * is load-bearing for the same reason: two posts written in one millisecond
   * would otherwise sort unstably across a page boundary.
   */
  async listByAuthor(
    query: ListAuthoredPostsQuery,
  ): Promise<readonly StoredPost[]> {
    const after = query.after;

    return this.store.communityPost.findMany({
      where: {
        authorId: query.authorId,
        deletedAt: null,
        hiddenAt: null,
        ...(after
          ? {
              OR: [
                { dateCreated: { lt: after.dateCreated } },
                { dateCreated: after.dateCreated, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ dateCreated: "desc" }, { id: "desc" }],
      take: query.limit,
    });
  }

  /**
   * Hides a post, once.
   *
   * **The `hiddenAt: null` in the `WHERE` is load-bearing.** It is what makes a
   * second hide match no row, so the first hide's timestamp survives — and that
   * is the timestamp an audit refers back to. Dropping it would let every later
   * hide overwrite the moment of the original decision.
   *
   * It is also the whole guard. There is no read before this write: a prior
   * `SELECT` would say "not yet hidden" about a row another request hides
   * before this one lands, whereas the predicate is evaluated by the same
   * statement that writes. `updateMany` rather than `update`, because `update`
   * accepts only unique fields in its `where` and throws on no match, where
   * "nothing moved" is an ordinary answer here.
   *
   * **Sets a column; deletes nothing.** The row stays, which is what makes a
   * bad call reversible.
   */
  async hide(postId: string, hiddenAt: Date): Promise<boolean> {
    const { count } = await this.store.communityPost.updateMany({
      where: { id: postId, hiddenAt: null },
      data: { hiddenAt },
    });
    return count === 1;
  }

  /**
   * Restores a post, once.
   *
   * **The `hiddenAt: { not: null }` in the `WHERE` is the mirror of `hide`'s
   * `hiddenAt: null`, and load-bearing for the same reason.** It makes a second
   * restore match no row, so the operation is idempotent and `count === 1`
   * means a row actually moved from hidden to visible. Without it an
   * `updateMany` on a visible row would still report a match and the caller
   * would be told it restored something it did not.
   *
   * As with `hide`, the predicate is the whole guard and no read precedes the
   * write. `ModerationService` does read report counts before calling this, but
   * that read decides *policy* — was the hide automatic — and not concurrency;
   * what keeps two racing restores from both claiming the row is this `WHERE`.
   */
  async unhide(postId: string): Promise<boolean> {
    const { count } = await this.store.communityPost.updateMany({
      where: { id: postId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    return count === 1;
  }

  /**
   * Rewrites an author's own title and body, and reads back what it wrote.
   *
   * **The `WHERE` carries the whole permission** — `authorId`, `hiddenAt: null`
   * and `deletedAt: null` — so the statement that writes is the statement that
   * decides. `updateMany` rather than `update` precisely because the predicate
   * is more than the primary key; `update` would need a unique `where` and
   * would throw on a miss instead of reporting one.
   *
   * **Update and read-back are one transaction**, following
   * `PrismaCommentRepository.insert`. Without it a moderator's hide committing
   * between the two would make the read-back — which filters hidden rows, as
   * every read here does — return `null` for an edit that had already landed,
   * and the author would be told the edit failed when it had not. Inside one
   * transaction the two statements agree: either the `WHERE` matched and the
   * row is returned as written, or it did not and the caller gets `null`.
   *
   * **`dateCreated` is not in `data`**, which is what keeps an edit from
   * bumping a post up the New feed (spec §8).
   */
  async editByAuthor(input: {
    postId: string;
    authorId: string;
    title: string;
    content: string;
    editedAt: Date;
  }): Promise<StoredPost | null> {
    return this.store.$transaction(async (tx) => {
      const { count } = await tx.communityPost.updateMany({
        where: {
          id: input.postId,
          authorId: input.authorId,
          hiddenAt: null,
          deletedAt: null,
        },
        data: {
          title: input.title,
          content: input.content,
          editedAt: input.editedAt,
        },
      });

      if (count !== 1) {
        return null;
      }

      return tx.communityPost.findFirst({ where: { id: input.postId } });
    });
  }

  /**
   * Sets `deletedAt` on an author's own live post.
   *
   * One guarded statement, no read and no transaction: there is nothing to read
   * back and no second row to keep in step, so the affected-row count is the
   * whole answer. `deletedAt: null` in the `WHERE` makes a second delete match
   * nothing, and `hiddenAt: null` keeps an author from writing their own
   * deletion over a moderator's record of what happened here (spec §8).
   */
  async softDeleteByAuthor(input: {
    postId: string;
    authorId: string;
    deletedAt: Date;
  }): Promise<boolean> {
    const { count } = await this.store.communityPost.updateMany({
      where: {
        id: input.postId,
        authorId: input.authorId,
        hiddenAt: null,
        deletedAt: null,
      },
      data: { deletedAt: input.deletedAt },
    });
    return count === 1;
  }
}

export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly store: CommentStore) {}

  /**
   * Inserts a comment and moves `commentCount`, atomically.
   *
   * Three things happen in one transaction, and all three have to:
   *
   *   1. The parent is locked and confirmed present, so the insert cannot
   *      orphan itself against a concurrent hard delete (spec §6.2).
   *   2. The comment is inserted.
   *   3. `commentCount` is incremented **relatively** — `SET comment_count =
   *      comment_count + 1`, never a read-modify-write, which would lose a
   *      concurrent increment (spec §9.2).
   *
   * A counter written in a later transaction could commit without the row that
   * justifies it, which is precisely the drift the counter design forbids.
   */
  async insert(input: {
    postId: string;
    authorId: string;
    content: string;
    dateCreated: Date;
  }): Promise<StoredComment | null> {
    return this.store.$transaction(async (tx) => {
      if (!(await lockPostForUpdate(tx, input.postId))) {
        return null;
      }

      const comment = await tx.communityComment.create({ data: input });

      await tx.communityPost.update({
        where: { id: input.postId },
        data: { commentCount: { increment: 1 } },
      });

      return comment;
    });
  }

  /**
   * One page of a thread.
   *
   * **Oldest first**, which is the one way this differs from the feed: a
   * conversation reads top to bottom, so the keyset comparison is `>` rather
   * than `<` and the ordering is ascending. The `id` tiebreak is load-bearing
   * in exactly the same way, and is served by
   * `@@index([postId, dateCreated, id])`.
   */
  async list(query: ListCommentsQuery): Promise<readonly StoredComment[]> {
    const after = query.after;

    return this.store.communityComment.findMany({
      where: {
        postId: query.postId,
        deletedAt: null,
        hiddenAt: null,
        ...(query.excludeAuthorIds.length > 0
          ? { authorId: { notIn: [...query.excludeAuthorIds] } }
          : {}),
        ...(after
          ? {
              OR: [
                { dateCreated: { gt: after.dateCreated } },
                { dateCreated: after.dateCreated, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ dateCreated: "asc" }, { id: "asc" }],
      take: query.limit,
    });
  }

  /**
   * One comment, filtered as a thread filters its rows.
   *
   * **The same three predicates as {@link list} and as
   * {@link PrismaPostRepository.findVisibleById}, plus the id.** A comment
   * hidden, deleted or by a block counterpart must be absent here as it is from
   * the thread, or this becomes a way to read what the thread declined to show.
   * `findFirst` rather than `findUnique`, because the filter is more than the
   * primary key.
   *
   * **The thread's fourth gate is not here.** `CommentService.list` reads the
   * parent post first, so a comment under a hidden or deleted post is absent
   * from the thread but still returns from this. That is acceptable: the block
   * filter is on the comment's own author, so the §7.2 probe stays closed, and
   * the one bit that differs — that the id still exists under a post the caller
   * can no longer read — tells the reporter nothing about the parent. A report
   * on such a comment is still evidence worth keeping.
   */
  async findVisibleById(
    commentId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredComment | null> {
    return this.store.communityComment.findFirst({
      where: {
        id: commentId,
        deletedAt: null,
        hiddenAt: null,
        ...(excludeAuthorIds.length > 0
          ? { authorId: { notIn: [...excludeAuthorIds] } }
          : {}),
      },
    });
  }

  /**
   * Hides a comment, once. See {@link PrismaPostRepository.hide}.
   *
   * **The `hiddenAt: null` in the `WHERE` is load-bearing**: it makes a second
   * hide match no row, so the first hide's timestamp — the one an audit refers
   * back to — is never overwritten, and it does so in the same statement that
   * writes rather than in a read that could be stale. The row is kept.
   */
  async hide(commentId: string, hiddenAt: Date): Promise<boolean> {
    const { count } = await this.store.communityComment.updateMany({
      where: { id: commentId, hiddenAt: null },
      data: { hiddenAt },
    });
    return count === 1;
  }

  /**
   * Restores a comment, once. See {@link PrismaPostRepository.unhide}.
   *
   * **The `hiddenAt: { not: null }` in the `WHERE` is load-bearing**: it is the
   * mirror of `hide`'s predicate, so a restore of a visible comment matches no
   * row and reports `false` instead of claiming a change it did not make.
   */
  async unhide(commentId: string): Promise<boolean> {
    const { count } = await this.store.communityComment.updateMany({
      where: { id: commentId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    return count === 1;
  }

  /**
   * Rewrites an author's own comment body, and reads back what it wrote.
   *
   * The same shape as `PrismaPostRepository.editByAuthor` and for the same
   * reasons: the whole permission is in the `WHERE`, and the update and the
   * read-back share a transaction so a hide landing between them cannot report
   * a successful edit as a failure.
   */
  async editByAuthor(input: {
    commentId: string;
    authorId: string;
    content: string;
    editedAt: Date;
  }): Promise<StoredComment | null> {
    return this.store.$transaction(async (tx) => {
      const { count } = await tx.communityComment.updateMany({
        where: {
          id: input.commentId,
          authorId: input.authorId,
          hiddenAt: null,
          deletedAt: null,
        },
        data: { content: input.content, editedAt: input.editedAt },
      });

      if (count !== 1) {
        return null;
      }

      return tx.communityComment.findFirst({ where: { id: input.commentId } });
    });
  }

  /**
   * Soft-deletes an author's own comment and decrements the parent's
   * `commentCount`, atomically.
   *
   * Three statements in one transaction, in this order, and the order matters:
   *
   *   1. The **guarded update** on the comment. Its `WHERE` carries the author
   *      and both flags, so this statement alone decides whether anything
   *      happens. A second delete matches nothing and the transaction returns
   *      `false` having written nothing — which is what keeps a retry from
   *      walking the counter down (spec §9.2.3).
   *   2. The parent's id, read **without** the visibility filter every other
   *      read here applies. The row was just soft-deleted, so a filtered read
   *      would not find it and the counter would never move.
   *   3. The **relative, floored** decrement — `SET comment_count =
   *      comment_count - 1` guarded by `comment_count > 0`. Relative because a
   *      read-modify-write would lose a concurrent reply's increment (§9.2.2);
   *      floored because drift from a purge or a manual edit must never render
   *      as a negative count (§9.2.4). A floor that refuses is correct here:
   *      the comment is deleted either way, and the counter was already wrong.
   *
   * The counter moves in the same transaction as the row that justifies it
   * (§9.2.1, §9.2.5), which is the invariant `insert` holds on the way up.
   */
  async softDeleteByAuthor(input: {
    commentId: string;
    authorId: string;
    deletedAt: Date;
  }): Promise<boolean> {
    return this.store.$transaction(async (tx) => {
      const { count } = await tx.communityComment.updateMany({
        where: {
          id: input.commentId,
          authorId: input.authorId,
          hiddenAt: null,
          deletedAt: null,
        },
        data: { deletedAt: input.deletedAt },
      });

      if (count !== 1) {
        return false;
      }

      const comment = await tx.communityComment.findFirst({
        where: { id: input.commentId },
      });

      if (comment) {
        await tx.communityPost.updateMany({
          where: { id: comment.postId, commentCount: { gt: 0 } },
          data: { commentCount: { decrement: 1 } },
        });
      }

      return true;
    });
  }
}
