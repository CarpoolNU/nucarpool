import type { ViewerSaveReader } from "../content/ports";
import type {
  ListSavedQuery,
  SavedPostRepository,
  StoredSave,
} from "../engagement/ports";

/** A stored row, with the `user_id` column the published shape leaves off. */
type SavedRow = StoredSave & { userId: string };

/**
 * In-memory `SavedPostRepository`, which is also the `ViewerSaveReader` that
 * `content` consumes — exactly as `PrismaSavedPostRepository` is in
 * production.
 *
 * **It enforces the unique pair rather than trusting the service.** That pair
 * is the entire idempotency guarantee, so a fake that let a second insert
 * through would make `save` look idempotent while the real index was the only
 * thing making it so — and the service would pass its tests while shipping a
 * duplicate row to MySQL.
 *
 * **It reproduces the real ordering, including the `id` tiebreak**, because a
 * keyset page boundary is exactly where a non-total order drops or repeats a
 * row, and two saves in the same millisecond are what a burst of clicking
 * produces.
 */
export class FakeSavedPostRepository
  implements SavedPostRepository, ViewerSaveReader
{
  rows: SavedRow[] = [];

  /**
   * How many times a caller asked for save state.
   *
   * Exposed so a test can assert the empty-page short circuit, which exists
   * because the feed reaches it on every page including the empty ones.
   */
  lookups = 0;

  private nextId = 1;

  async insert(input: {
    userId: string;
    postId: string;
    dateCreated: Date;
  }): Promise<"inserted" | "already-saved"> {
    if (this.find(input.userId, input.postId)) {
      return "already-saved";
    }

    this.rows.push({
      id: `save-${String(this.nextId++).padStart(3, "0")}`,
      userId: input.userId,
      postId: input.postId,
      dateCreated: input.dateCreated,
    });
    return "inserted";
  }

  async remove(input: {
    userId: string;
    postId: string;
  }): Promise<"removed" | "not-saved"> {
    const row = this.find(input.userId, input.postId);
    if (!row) {
      return "not-saved";
    }

    this.rows = this.rows.filter((candidate) => candidate !== row);
    return "removed";
  }

  async list(query: ListSavedQuery): Promise<readonly StoredSave[]> {
    const ordered = this.rows
      .filter((row) => row.userId === query.userId)
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

  async savedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    this.lookups += 1;
    const saved = new Set(
      this.rows.filter((row) => row.userId === userId).map((row) => row.postId),
    );
    return new Set(postIds.filter((id) => saved.has(id)));
  }

  private find(userId: string, postId: string): SavedRow | undefined {
    return this.rows.find(
      (row) => row.userId === userId && row.postId === postId,
    );
  }
}
