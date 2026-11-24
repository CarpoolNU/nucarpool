import type { CommentRepository, PostRepository } from "./ports";
import type {
  ContentTarget,
  ContentTargetHider,
  ContentTargetReader,
  TargetType,
} from "./public";

/**
 * What `content` publishes to `moderation`: a post or a comment, read as a
 * report target, hidden on a moderator's decision, and restored on one.
 *
 * **The `switch` over {@link TargetType} lives here and nowhere else**, so
 * `moderation` holds the discriminator and `content` holds what each arm
 * means. A third target type is one new arm in each method, and the compiler
 * names both through the exhaustiveness check.
 *
 * **The snapshot is server-built from the stored row, and no caller-supplied
 * string ever reaches it.** The post snapshot joins title and body; the comment
 * snapshot is the body. That is what makes it evidence: it records what the
 * row said when the report was filed, whatever the author does to it next and
 * whatever the reporter claims.
 *
 * **An id of the wrong type is simply not found.** Each arm asks only its own
 * table, and a post's id is not a row in `community_comment`, so the lookup
 * returns `null` — no type check of its own is needed.
 */
export class ContentTargets implements ContentTargetReader, ContentTargetHider {
  constructor(
    private readonly posts: PostRepository,
    private readonly comments: CommentRepository,
  ) {}

  async findVisibleTarget(
    type: TargetType,
    id: string,
    excludeAuthorIds: readonly string[],
  ): Promise<ContentTarget | null> {
    switch (type) {
      case "POST": {
        const post = await this.posts.findVisibleById(id, excludeAuthorIds);
        return post
          ? {
              authorId: post.authorId,
              snapshot: `${post.title}\n\n${post.content}`,
            }
          : null;
      }
      case "COMMENT": {
        const comment = await this.comments.findVisibleById(
          id,
          excludeAuthorIds,
        );
        return comment
          ? { authorId: comment.authorId, snapshot: comment.content }
          : null;
      }
      default:
        return assertNever(type);
    }
  }

  async hide(type: TargetType, id: string, hiddenAt: Date): Promise<boolean> {
    switch (type) {
      case "POST":
        return this.posts.hide(id, hiddenAt);
      case "COMMENT":
        return this.comments.hide(id, hiddenAt);
      default:
        return assertNever(type);
    }
  }

  async restore(type: TargetType, id: string): Promise<boolean> {
    switch (type) {
      case "POST":
        return this.posts.unhide(id);
      case "COMMENT":
        return this.comments.unhide(id);
      default:
        return assertNever(type);
    }
  }
}

const assertNever = (value: never): never => {
  throw new Error(`Unhandled target type: ${String(value)}`);
};
