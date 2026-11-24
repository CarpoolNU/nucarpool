import type {
  CategoryRepository,
  ListAuthoredPostsQuery,
  ListPostsQuery,
  PostRepository,
  StoredCategory,
  StoredPost,
} from "../content/ports";

export class FakeCategoryRepository implements CategoryRepository {
  constructor(private rows: StoredCategory[] = []) {}

  static withDefaults(): FakeCategoryRepository {
    return new FakeCategoryRepository([
      {
        id: "cat-commuting",
        slug: "commuting",
        name: "Commuting",
        description: "",
        sortOrder: 1,
      },
      {
        id: "cat-parking",
        slug: "parking",
        name: "Parking",
        description: "",
        sortOrder: 2,
      },
    ]);
  }

  withInactive(category: StoredCategory): this {
    // Present to `findBySlug`, absent from `listActive` — which is exactly the
    // shape a retired category has in the database.
    this.inactive.push(category);
    return this;
  }

  /**
   * Retires a category that is already here, as the database does: the row
   * stays, `is_active` goes false.
   *
   * **Distinct from {@link withInactive}, which starts a category retired.**
   * A category that was never active can hold no posts, so it cannot reach the
   * read path at all; the defect that does — a post written while its category
   * was live — needs the transition, not the end state.
   */
  retire(slug: string): this {
    const index = this.rows.findIndex((row) => row.slug === slug);
    if (index === -1) {
      throw new Error(`no active category ${slug} to retire`);
    }
    this.inactive.push(...this.rows.splice(index, 1));
    return this;
  }

  private inactive: StoredCategory[] = [];

  async findBySlug(slug: string): Promise<StoredCategory | null> {
    return (
      [...this.rows, ...this.inactive].find((row) => row.slug === slug) ?? null
    );
  }

  async findManyByIds(
    ids: readonly string[],
  ): Promise<readonly StoredCategory[]> {
    const wanted = new Set(ids);
    return [...this.rows, ...this.inactive].filter((row) => wanted.has(row.id));
  }

  async listActive(): Promise<readonly StoredCategory[]> {
    return [...this.rows].sort((a, b) => a.sortOrder - b.sortOrder);
  }
}

/**
 * Whether a row matches a search term, by the same rule MySQL applies.
 *
 * **Case-insensitive, because the real query is**, and not by choice: the
 * `community_post` columns carry MySQL's default `utf8mb4` collation, which is
 * `_ci`, so `LIKE` there ignores case whether or not anybody intended it.
 * (Prisma's `mode: "insensitive"` is a PostgreSQL feature and would do nothing
 * here.) A case-*sensitive* fake would pass a test the database fails, which
 * is the one failure mode a fake must not have.
 *
 * **Literal, with no wildcard handling, for the same reason.** The real
 * repository escapes `%` and `_` precisely so they mean themselves; `includes`
 * already treats them that way, so mirroring the escaping here would be
 * mirroring a workaround rather than the behaviour it produces.
 */
const matchesSearch = (row: StoredPost, search: string | null): boolean => {
  if (search === null) {
    return true;
  }
  const term = search.toLowerCase();
  return (
    row.title.toLowerCase().includes(term) ||
    row.content.toLowerCase().includes(term)
  );
};

/**
 * In-memory `PostRepository`.
 *
 * **It reproduces both real orderings, including the `id` tiebreak**, because
 * the service's pagination correctness depends on each ordering being total.
 * A fake that sorted only by date — or, on the Top feed, only by count — would
 * hide exactly the bug the tiebreak exists to prevent, and on Top it would
 * hide it almost always, since equal counts are the normal case rather than a
 * coincidence.
 */
export class FakePostRepository implements PostRepository {
  rows: StoredPost[] = [];
  private nextId = 1;

  async insert(input: {
    authorId: string;
    categoryId: string;
    title: string;
    content: string;
    dateCreated: Date;
  }): Promise<StoredPost> {
    const stored: StoredPost = {
      id: `post-${String(this.nextId++).padStart(3, "0")}`,
      voteCount: 0,
      commentCount: 0,
      hiddenAt: null,
      deletedAt: null,
      editedAt: null,
      ...input,
    };
    this.rows.push(stored);
    return stored;
  }

  /**
   * Applies the same four-reason collapse the real repository does: unknown
   * id, deleted, hidden and blocked-author all return `null`.
   */
  async findVisibleById(
    postId: string,
    excludeAuthorIds: readonly string[],
  ): Promise<StoredPost | null> {
    const row = this.rows.find((candidate) => candidate.id === postId);
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

  /** The same collapse as {@link findVisibleById}, applied to a set of ids. */
  async findVisibleByIds(
    postIds: readonly string[],
    excludeAuthorIds: readonly string[],
  ): Promise<readonly StoredPost[]> {
    const wanted = new Set(postIds);
    return this.rows.filter(
      (row) =>
        wanted.has(row.id) &&
        row.deletedAt === null &&
        row.hiddenAt === null &&
        !excludeAuthorIds.includes(row.authorId),
    );
  }

  /**
   * First write wins, as the real `WHERE hiddenAt IS NULL` makes it.
   *
   * **The fake enforces the constraint rather than trusting the service.** A
   * fake that let a second hide overwrite the timestamp would make the real
   * `WHERE` clause the only thing preserving it, and the service would pass its
   * tests while the first-hide guarantee rested on a predicate no test reached.
   */
  async hide(postId: string, hiddenAt: Date): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === postId);
    if (!row || row.hiddenAt !== null) {
      return false;
    }
    row.hiddenAt = hiddenAt;
    return true;
  }

  /**
   * Clears `hiddenAt` only on a hidden row, as the real `WHERE hiddenAt IS NOT
   * NULL` does, so a second restore and an unknown id both report `false` —
   * the fake enforces the idempotence rather than leaving it to the predicate.
   */
  async unhide(postId: string): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === postId);
    if (!row || row.hiddenAt === null) {
      return false;
    }
    row.hiddenAt = null;
    return true;
  }

  /**
   * Rewrites title and body on a row that is the author's and still live.
   *
   * **The fake enforces the whole predicate rather than trusting the service.**
   * It checks `authorId`, `hiddenAt` and `deletedAt` exactly as the real
   * `WHERE` does, so a service that dropped its own author check would still
   * fail here — which is the point of the permission living in the statement.
   */
  async editByAuthor(input: {
    postId: string;
    authorId: string;
    title: string;
    content: string;
    editedAt: Date;
  }): Promise<StoredPost | null> {
    const row = this.rows.find((candidate) => candidate.id === input.postId);
    if (
      !row ||
      row.authorId !== input.authorId ||
      row.hiddenAt !== null ||
      row.deletedAt !== null
    ) {
      return null;
    }
    row.title = input.title;
    row.content = input.content;
    row.editedAt = input.editedAt;
    return row;
  }

  /**
   * Sets `deletedAt` on a live row of the author's own, as the real guarded
   * update does. A second delete, someone else's post, and a hidden row all
   * report `false`.
   */
  async softDeleteByAuthor(input: {
    postId: string;
    authorId: string;
    deletedAt: Date;
  }): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === input.postId);
    if (
      !row ||
      row.authorId !== input.authorId ||
      row.hiddenAt !== null ||
      row.deletedAt !== null
    ) {
      return false;
    }
    row.deletedAt = input.deletedAt;
    return true;
  }

  /**
   * Removes the row outright, as a purge or a cascade does.
   *
   * Distinct from `deletedAt`, the author's soft delete: this is the case where
   * a report outlives the very row it points at, and a later `hide` finds
   * nothing to move.
   */
  async hardDelete(postId: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.id !== postId);
  }

  /**
   * The stored row whatever its state, hidden or deleted included.
   *
   * Exists so a test can assert a hidden post is *still stored* — which is the
   * point of hide-not-delete. Throws on an unknown id, so a typo cannot read as
   * "the row is gone".
   */
  rowFor(postId: string): StoredPost {
    const row = this.rows.find((candidate) => candidate.id === postId);
    if (!row) {
      throw new Error(`No post row ${postId}`);
    }
    return row;
  }

  async list(query: ListPostsQuery): Promise<readonly StoredPost[]> {
    const visible = this.rows
      .filter((row) => row.deletedAt === null && row.hiddenAt === null)
      .filter(
        (row) =>
          query.categoryId === null || row.categoryId === query.categoryId,
      )
      .filter((row) => !query.excludeAuthorIds.includes(row.authorId))
      .filter((row) => matchesSearch(row, query.search));

    // Both orders are descending on their key with `id` descending behind it,
    // which is what the two declared index tuples give the real query.
    const key = (row: StoredPost) =>
      query.sort === "top" ? row.voteCount : row.dateCreated.getTime();
    const ordered = visible.sort(
      (a, b) => key(b) - key(a) || b.id.localeCompare(a.id),
    );

    const after = query.after;
    const afterKey = after
      ? after.sort === "top"
        ? after.voteCount
        : after.dateCreated.getTime()
      : null;
    const afterCursor =
      after && afterKey !== null
        ? ordered.filter(
            (row) =>
              key(row) < afterKey ||
              (key(row) === afterKey && row.id.localeCompare(after.id) < 0),
          )
        : ordered;

    return afterCursor.slice(0, query.limit);
  }

  /**
   * Newest first with the `id` tiebreak behind it, which is what
   * `@@index([authorId, dateCreated, id])` gives the real query. A fake that
   * sorted on the date alone would hide the duplicate-or-drop the tiebreak
   * exists to prevent.
   */
  async listByAuthor(
    query: ListAuthoredPostsQuery,
  ): Promise<readonly StoredPost[]> {
    const ordered = this.rows
      .filter(
        (row) =>
          row.authorId === query.authorId &&
          row.deletedAt === null &&
          row.hiddenAt === null,
      )
      .sort(
        (a, b) =>
          b.dateCreated.getTime() - a.dateCreated.getTime() ||
          b.id.localeCompare(a.id),
      );

    const after = query.after;
    const page = after
      ? ordered.filter(
          (row) =>
            row.dateCreated.getTime() < after.dateCreated.getTime() ||
            (row.dateCreated.getTime() === after.dateCreated.getTime() &&
              row.id.localeCompare(after.id) < 0),
        )
      : ordered;

    return page.slice(0, query.limit);
  }
}
