import type { ViewerSaveReader } from "../content/ports";
import type { ListSavedQuery, SavedPostRepository, StoredSave } from "./ports";

/**
 * The delegates a save touches.
 *
 * **No `$transaction`, unlike {@link VoteStore}.** A vote writes two things —
 * the row and `voteCount` — so it needs both to land together and needs the
 * parent locked while they do. A save writes one row and moves no counter, so
 * there is nothing for a transaction to make atomic.
 *
 * `findMany` is declared once and called twice; the `select` in
 * `savedPostIds` narrows what actually comes back to `postId`, which is the
 * only field that call reads.
 */
export type SavedPostStore = {
  communitySavedPost: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(args: {
      where: { userId: string; postId: string };
    }): Promise<{ count: number }>;
    findMany(args: Record<string, unknown>): Promise<StoredSave[]>;
  };
};

/**
 * Prisma's unique-constraint error, narrowed to the one index that matters
 * here.
 *
 * `community_saved_post` has exactly one unique index,
 * `@@unique([userId, postId])`, so a P2002 on this insert can mean nothing
 * else.
 */
const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "P2002";

export class PrismaSavedPostRepository
  implements SavedPostRepository, ViewerSaveReader
{
  constructor(private readonly store: SavedPostStore) {}

  /**
   * Inserts a save.
   *
   * **It does not ask whether the user has already saved it.** The insert goes
   * straight at the unique index and a duplicate-key error *is* the answer,
   * which is what makes a double-clicked save button harmless under any
   * concurrency — where a prior read would let two requests both see no save
   * and both insert, and the loser would get an unhandled database fault
   * instead of a quiet success (spec §6.3).
   */
  async insert(input: {
    userId: string;
    postId: string;
    dateCreated: Date;
  }): Promise<"inserted" | "already-saved"> {
    try {
      await this.store.communitySavedPost.create({ data: input });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return "already-saved";
      }
      throw error;
    }
    return "inserted";
  }

  /**
   * Deletes a save, if there is one.
   *
   * **The affected-row count is the signal**, the same pattern
   * `PrismaVoteRepository.remove` uses: `deleteMany` reports what it removed,
   * so an unsave of something never saved is a plain `0` rather than an error
   * to catch.
   */
  async remove(input: {
    userId: string;
    postId: string;
  }): Promise<"removed" | "not-saved"> {
    const deleted = await this.store.communitySavedPost.deleteMany({
      where: { userId: input.userId, postId: input.postId },
    });
    return deleted.count === 1 ? "removed" : "not-saved";
  }

  /**
   * One keyset page of this user's saves, newest save first.
   *
   * **The `OR` is the tuple comparison `(dateCreated, id) < (?, ?)`** written
   * the way Prisma can express it, served by
   * `@@index([userId, dateCreated, id])` — the index `community.prisma` has
   * carried since the original design with nothing reading it.
   *
   * The trailing `id` is load-bearing: someone working through a feed saves
   * several posts in the same second, and without a total order a page
   * boundary inside that run would drop or repeat one.
   *
   * **No visibility filter here.** Whether the post behind a save is still
   * readable is the `content` module's question, asked once for the whole page
   * after this returns; answering it in this query would put `content`'s three
   * predicates in a second place, where they could drift from the feed's.
   */
  async list(query: ListSavedQuery): Promise<readonly StoredSave[]> {
    const after = query.after;

    return this.store.communitySavedPost.findMany({
      where: {
        userId: query.userId,
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
   * Which of these posts the viewer has saved.
   *
   * **Selects only `postId`.** The caller needs set membership and nothing
   * else — not when it was saved, and not the save's own id, which is a handle
   * on a row no client addresses.
   */
  async savedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (postIds.length === 0) {
      return new Set();
    }

    const rows = await this.store.communitySavedPost.findMany({
      where: { userId, postId: { in: [...postIds] } },
      select: { postId: true },
    });

    return new Set(rows.map((row) => row.postId));
  }
}
