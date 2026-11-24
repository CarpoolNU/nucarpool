import type {
  CommentRepository,
  ListCommentsQuery,
  StoredComment,
} from "../content/ports";
import type { FakePostRepository } from "./fakeContentRepositories";

/**
 * In-memory `CommentRepository`.
 *
 * **It reproduces the real ordering including the `id` tiebreak**, for the
 * reason `FakePostRepository` gives: a fake that sorted only by date would
 * hide exactly the paging bug the tiebreak exists to prevent.
 *
 * **It also reproduces the counter being written by the same operation as the
 * insert**, by incrementing the post row it shares with `FakePostRepository`.
 * A fake that left `commentCount` alone would let a service forget the
 * increment and still pass.
 */
export class FakeCommentRepository implements CommentRepository {
  rows: StoredComment[] = [];
  private nextId = 1;

  constructor(private readonly posts: FakePostRepository) {}

  async insert(input: {
    postId: string;
    authorId: string;
    content: string;
    dateCreated: Date;
  }): Promise<StoredComment | null> {
    const post = this.posts.rows.find((row) => row.id === input.postId);
    if (!post) {
      return null;
    }

    const stored: StoredComment = {
      id: `comment-${String(this.nextId++).padStart(3, "0")}`,
      hiddenAt: null,
      deletedAt: null,
      editedAt: null,
      ...input,
    };
    this.rows.push(stored);
    post.commentCount += 1;
    return stored;
  }

  async list(query: ListCommentsQuery): Promise<readonly StoredComment[]> {
    const ordered = this.rows
      .filter((row) => row.postId === query.postId)
      .filter((row) => row.deletedAt === null && row.hiddenAt === null)
      .filter((row) => !query.excludeAuthorIds.includes(row.authorId))
      // Oldest first — a thread reads top to bottom.
      .sort(
        (a, b) =>
          a.dateCreated.getTime() - b.dateCreated.getTime() ||
          a.id.localeCompare(b.id),
      );

    const after = query.after;
    const afterCursor = after
      ? ordered.filter(
          (row) =>
            row.dateCreated.getTime() > after.dateCreated.getTime() ||
            (row.dateCreated.getTime() === after.dateCreated.getTime() &&
              row.id.localeCompare(after.id) > 0),
        )
      : ordered;

    return afterCursor.slice(0, query.limit);
  }

  /** The same four-reason collapse as `FakePostRepository.findVisibleById`. */
  async findVisibleById(
    commentId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredComment | null> {
    const row = this.rows.find((candidate) => candidate.id === commentId);
    if (
      !row ||
      row.deletedAt !== null ||
      row.hiddenAt !== null ||
      excludeAuthorIds.includes(row.authorId)
    ) {
      return null;
    }
    return row;
  }

  /**
   * First write wins, as the real `WHERE hiddenAt IS NULL` makes it — for the
   * reason `FakePostRepository.hide` gives: the fake enforces the constraint
   * rather than trusting the service to.
   */
  async hide(commentId: string, hiddenAt: Date): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === commentId);
    if (!row || row.hiddenAt !== null) {
      return false;
    }
    row.hiddenAt = hiddenAt;
    return true;
  }

  /**
   * Only a hidden row moves, as the real `WHERE hiddenAt IS NOT NULL` makes it
   * — for the reason `FakePostRepository.unhide` gives.
   */
  async unhide(commentId: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === commentId);
    if (!row || row.hiddenAt === null) {
      return false;
    }
    row.hiddenAt = null;
    return true;
  }

  /**
   * Rewrites the body on a row that is the author's and still live.
   *
   * **The fake enforces the whole predicate**, for the reason
   * `FakePostRepository.editByAuthor` gives: a service that dropped its own
   * author check must still fail here.
   */
  async editByAuthor(input: {
    commentId: string;
    authorId: string;
    content: string;
    editedAt: Date;
  }): Promise<StoredComment | null> {
    const row = this.rows.find((candidate) => candidate.id === input.commentId);
    if (
      !row ||
      row.authorId !== input.authorId ||
      row.hiddenAt !== null ||
      row.deletedAt !== null
    ) {
      return null;
    }
    row.content = input.content;
    row.editedAt = input.editedAt;
    return row;
  }

  /**
   * Soft-deletes and decrements the parent's counter together, as the real
   * transaction does.
   *
   * **It moves `commentCount` for the same reason `insert` does**: a fake that
   * left the counter alone would let a service — or a repository — forget the
   * decrement and still pass, which is exactly the drift spec §9.2.5 exists to
   * prevent. The decrement is floored at zero (§9.2.4), and it happens only
   * when a row actually moved, so a refused second delete cannot walk the
   * counter down.
   */
  async softDeleteByAuthor(input: {
    commentId: string;
    authorId: string;
    deletedAt: Date;
  }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === input.commentId);
    if (
      !row ||
      row.authorId !== input.authorId ||
      row.hiddenAt !== null ||
      row.deletedAt !== null
    ) {
      return false;
    }
    row.deletedAt = input.deletedAt;

    const post = this.posts.rows.find(
      (candidate) => candidate.id === row.postId,
    );
    if (post) {
      post.commentCount = Math.max(0, post.commentCount - 1);
    }
    return true;
  }

  /**
   * The stored row whatever its state, so a test can assert a hidden comment is
   * still there. Throws on an unknown id.
   */
  rowFor(commentId: string): StoredComment {
    const row = this.rows.find((candidate) => candidate.id === commentId);
    if (!row) {
      throw new Error(`No comment row ${commentId}`);
    }
    return row;
  }
}
