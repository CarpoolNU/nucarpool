import { z } from "zod";
import { router } from "../createRouter";
import { COMMENT_CONTENT_MAX_LENGTH } from "../../community/content/domain/textLimits";
import { MAX_PAGE_SIZE } from "../../community/shared/paging";
import {
  budgetedMember,
  communityStudentProcedure,
  mapDomainErrors,
} from "./procedures";

/**
 * Comments on a post.
 *
 * Reading a thread is `communityStudentProcedure` — a signed-in student may
 * follow a discussion before choosing a handle — and replying is
 * `budgetedMember`, which builds on the member tier, so both "may this actor
 * write" and "have they written too much" stay properties of the procedure
 * rather than checks inside the handler.
 *
 * There is no `postId` validation beyond a length bound here on purpose: every
 * reason a post id might be unusable (absent, deleted, hidden, blocked author)
 * is resolved by the service into one `NOT_FOUND`, and a Zod `cuid()` check
 * would distinguish "malformed" from "not found" at the boundary — handing back
 * exactly the signal spec §7.2 is about suppressing.
 */
export const commentsRouter = router({
  list: communityStudentProcedure
    .input(
      z.object({
        postId: z.string().min(1).max(64),
        cursor: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.comments.list(ctx.actor, input)),
    ),

  create: budgetedMember("COMMENT_CREATE")
    .input(
      z.object({
        postId: z.string().min(1).max(64),
        // Matches `community_comment.content`'s VARCHAR(2000). The cap has to
        // match the column: MySQL runs in strict mode, so an oversized value
        // throws rather than truncates, and a mismatched cap would let the
        // composer clear the user's text before the write failed.
        content: z.string().max(COMMENT_CONTENT_MAX_LENGTH),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.comments.create(ctx.actor, input)),
    ),

  /**
   * **`commentId`, and no `postId`** (spec §10). The parent is a property of
   * the comment, so taking it from the client would be taking a claim the
   * server has to verify anyway — and a mismatched pair would be a third thing
   * to decide how to refuse.
   */
  edit: budgetedMember("CONTENT_EDIT")
    .input(
      z.object({
        commentId: z.string().min(1).max(64),
        content: z.string().max(COMMENT_CONTENT_MAX_LENGTH),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.comments.edit(ctx.actor, input)),
    ),

  /**
   * The author's own soft delete. As with `posts.delete`, there is no
   * moderator branch: a moderator hides through `moderation.review`, which
   * writes `hiddenAt` and leaves an audit entry.
   */
  delete: budgetedMember("CONTENT_DELETE")
    .input(z.object({ commentId: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.comments.delete(ctx.actor, input)),
    ),
});
