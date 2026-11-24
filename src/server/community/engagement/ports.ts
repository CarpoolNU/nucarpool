import type { NewCursor } from "../shared/cursor";

/**
 * The persistence contract for upvotes.
 *
 * **Every method reports what the database decided, not what the caller
 * intended.** `insert` returns whether a row was created; `remove` returns
 * whether one was deleted. That is the whole mechanism behind idempotent
 * `vote`/`unvote` (spec §10.1): the `@@unique([userId, postId])` index is the
 * arbiter, and the boolean is its verdict travelling back up.
 *
 * Nothing here does check-then-write. A prior "has this user voted?" read
 * leaves a window in which two concurrent requests both see no vote and both
 * insert, and the loser gets an unhandled database fault instead of a quiet
 * success.
 */
export interface VoteRepository {
  /**
   * Inserts a vote and increments `voteCount` in the same transaction.
   *
   * - `"inserted"` — the row is new and the counter moved.
   * - `"already-voted"` — the unique index refused; nothing changed, and the
   *   caller should still succeed. This is what makes a double-click harmless.
   * - `"no-post"` — the parent was absent when the lock was taken.
   */
  insert(input: {
    userId: string;
    postId: string;
    dateCreated: Date;
  }): Promise<"inserted" | "already-voted" | "no-post">;

  /**
   * Deletes a vote and decrements `voteCount` in the same transaction.
   *
   * **Decrements only when exactly one row was removed**, and never below
   * zero. A counter the UI renders must not be able to go negative because a
   * retry arrived twice (spec §9.2, points 3 and 4).
   */
  remove(input: {
    userId: string;
    postId: string;
  }): Promise<"removed" | "not-voted">;

  /** The current stored count, for returning to the caller after a change. */
  countFor(postId: string): Promise<number>;
}

/**
 * One row of someone's saved list, as the list query returns it.
 *
 * **`id` is the saved row's id, not the post's**, because it is the keyset
 * tiebreak: the index this list pages over is
 * `@@index([userId, dateCreated, id])` on `community_saved_post`, so the
 * cursor's second component has to be that table's primary key. Nothing else
 * about the save is published — the post itself is fetched separately, through
 * the module that owns it.
 */
export type StoredSave = {
  id: string;
  postId: string;
  dateCreated: Date;
};

export type ListSavedQuery = {
  userId: string;
  /** Where the previous page ended. Newest save first, so the same shape the feed uses. */
  after: NewCursor | null;
  /** One more than the page size, so "is there a next page?" needs no COUNT. */
  limit: number;
};

/**
 * The persistence contract for bookmarks.
 *
 * **It reports what the database decided, exactly as {@link VoteRepository}
 * does**: `insert` says whether a row was created, `remove` whether one was
 * deleted, and the `@@unique([userId, postId])` pair is the arbiter in both
 * cases. That is what makes `save`/`unsave` idempotent under a retry rather
 * than merely usually-idempotent.
 *
 * **Unlike a vote, a save moves no counter**, so nothing here opens a
 * transaction or locks the parent post. The lock in `VoteRepository.insert`
 * exists to keep `voteCount` from moving for a post that is being deleted
 * underneath it; with no counter to protect, a save against a row that is
 * disappearing leaves a dangling bookmark, which the list filter already has
 * to handle for the three ordinary reasons a saved post stops being visible.
 */
export interface SavedPostRepository {
  /**
   * - `"inserted"` — the row is new.
   * - `"already-saved"` — the unique pair refused; nothing changed, and the
   *   caller should still succeed.
   */
  insert(input: {
    userId: string;
    postId: string;
    dateCreated: Date;
  }): Promise<"inserted" | "already-saved">;

  remove(input: {
    userId: string;
    postId: string;
  }): Promise<"removed" | "not-saved">;

  /** One keyset page of this user's saves, newest save first. */
  list(query: ListSavedQuery): Promise<readonly StoredSave[]>;
}
