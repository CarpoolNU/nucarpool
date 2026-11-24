import {
  lockPostForUpdate,
  type CommentTxStore,
} from "../content/prismaContentRepositories";
import type { ViewerVoteReader } from "../content/ports";
import type { VoteRepository } from "./ports";

/**
 * The delegates a vote touches inside a transaction.
 *
 * It extends `CommentTxStore` to reuse {@link lockPostForUpdate} — the parent
 * lock is the same statement against the same table, and writing it twice is
 * how two copies drift apart.
 */
export type VoteTxStore = CommentTxStore & {
  communityPostVote: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(args: {
      where: { userId: string; postId: string };
    }): Promise<{ count: number }>;
  };
  communityPost: {
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
};

export type VoteStore = VoteTxStore & {
  communityPost: {
    findUnique(args: {
      where: { id: string };
      select: { voteCount: true };
    }): Promise<{ voteCount: number } | null>;
  };
  communityPostVote: {
    findMany(args: {
      where: { userId: string; postId: { in: string[] } };
      select: { postId: true };
    }): Promise<Array<{ postId: string }>>;
  };
  $transaction<T>(run: (tx: VoteTxStore) => Promise<T>): Promise<T>;
};

/**
 * Prisma's unique-constraint error, narrowed to the one index that matters
 * here.
 *
 * Matching on the code alone is enough: `community_post_vote` has exactly one
 * unique index, `@@unique([userId, postId])`, so a P2002 on this insert can
 * mean nothing else.
 */
const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "P2002";

export class PrismaVoteRepository implements VoteRepository, ViewerVoteReader {
  constructor(private readonly store: VoteStore) {}

  /**
   * Inserts a vote and increments `voteCount`, atomically.
   *
   * **It does not ask whether the user has already voted.** The insert goes
   * straight at the unique index and a duplicate-key error *is* the answer —
   * which is what makes a double-clicked vote button harmless under any
   * concurrency, where a prior read would let two requests both see no vote and
   * both insert (spec §6.3).
   *
   * The duplicate path increments nothing, so the counter follows the rows
   * rather than the requests.
   */
  async insert(input: {
    userId: string;
    postId: string;
    dateCreated: Date;
  }): Promise<"inserted" | "already-voted" | "no-post"> {
    return this.store.$transaction(async (tx) => {
      if (!(await lockPostForUpdate(tx, input.postId))) {
        return "no-post";
      }

      try {
        await tx.communityPostVote.create({ data: input });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return "already-voted";
        }
        throw error;
      }

      await tx.communityPost.update({
        where: { id: input.postId },
        data: { voteCount: { increment: 1 } },
      });

      return "inserted";
    });
  }

  /**
   * Deletes a vote and decrements `voteCount`, atomically.
   *
   * **The affected-row count is the signal** (spec §9.2, point 3, the pattern
   * `admin.resolveReport` already uses): `deleteMany` reports how many rows it
   * removed, and anything other than exactly one means this user had no vote,
   * so nothing is decremented. Deciding from a prior read instead would let two
   * concurrent unvotes both decrement for one deleted row.
   *
   * **The decrement is floored in the `where` clause, not in JavaScript.**
   * `voteCount: { gt: 0 }` makes the guard a condition the database evaluates
   * at write time; a check in application code would be read-then-write and
   * could still race a concurrent decrement to below zero. A counter the UI
   * renders must never be able to go negative (spec §9.2, point 4).
   */
  async remove(input: {
    userId: string;
    postId: string;
  }): Promise<"removed" | "not-voted"> {
    return this.store.$transaction(async (tx) => {
      const deleted = await tx.communityPostVote.deleteMany({
        where: { userId: input.userId, postId: input.postId },
      });

      if (deleted.count !== 1) {
        return "not-voted";
      }

      await tx.communityPost.updateMany({
        where: { id: input.postId, voteCount: { gt: 0 } },
        data: { voteCount: { decrement: 1 } },
      });

      return "removed";
    });
  }

  async countFor(postId: string): Promise<number> {
    const row = await this.store.communityPost.findUnique({
      where: { id: postId },
      select: { voteCount: true },
    });
    return row?.voteCount ?? 0;
  }

  /**
   * Which of these posts the viewer has voted on.
   *
   * **Selects only `postId`.** The caller needs set membership and nothing
   * else, and who voted for what is not information this module hands out.
   */
  async votedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (postIds.length === 0) {
      return new Set();
    }

    const rows = await this.store.communityPostVote.findMany({
      where: { userId, postId: { in: [...postIds] } },
      select: { postId: true },
    });

    return new Set(rows.map((row) => row.postId));
  }
}
