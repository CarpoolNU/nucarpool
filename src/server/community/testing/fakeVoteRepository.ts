import type { VoteRepository } from "../engagement/ports";
import type { ViewerVoteReader } from "../content/ports";
import type { FakePostRepository } from "./fakeContentRepositories";

/**
 * In-memory `VoteRepository`, which is also the `ViewerVoteReader` that
 * `content` consumes — exactly as `PrismaVoteRepository` is in production.
 *
 * **It enforces the unique pair rather than trusting the service**, because
 * that pair is the entire idempotency guarantee. A fake that let a second
 * insert through would make `vote` look idempotent while the real index was
 * the only thing making it so.
 *
 * **It floors the decrement**, for the same reason: the floor is a storage
 * property in production, and a fake without it would let a service that
 * decrements unconditionally pass.
 */
export class FakeVoteRepository implements VoteRepository, ViewerVoteReader {
  /** `userId` → the posts they have voted on. */
  private byUser = new Map<string, Set<string>>();

  /**
   * How many times the feed asked for vote state.
   *
   * Exposed so a test can assert the empty-page short circuit, which exists
   * because the feed calls this on every page including empty ones.
   */
  lookups = 0;

  constructor(private readonly posts: FakePostRepository) {}

  async insert(input: {
    userId: string;
    postId: string;
    dateCreated: Date;
  }): Promise<"inserted" | "already-voted" | "no-post"> {
    const post = this.posts.rows.find((row) => row.id === input.postId);
    if (!post) {
      return "no-post";
    }

    const voted = this.byUser.get(input.userId) ?? new Set<string>();
    if (voted.has(input.postId)) {
      return "already-voted";
    }

    voted.add(input.postId);
    this.byUser.set(input.userId, voted);
    post.voteCount += 1;
    return "inserted";
  }

  async remove(input: {
    userId: string;
    postId: string;
  }): Promise<"removed" | "not-voted"> {
    const voted = this.byUser.get(input.userId);
    if (!voted?.delete(input.postId)) {
      return "not-voted";
    }

    const post = this.posts.rows.find((row) => row.id === input.postId);
    if (post) {
      post.voteCount = Math.max(0, post.voteCount - 1);
    }
    return "removed";
  }

  async countFor(postId: string): Promise<number> {
    return this.posts.rows.find((row) => row.id === postId)?.voteCount ?? 0;
  }

  async votedPostIds(
    userId: string,
    postIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    this.lookups += 1;
    const voted = this.byUser.get(userId) ?? new Set<string>();
    return new Set(postIds.filter((id) => voted.has(id)));
  }
}
