import { z } from "zod";
import { router } from "../createRouter";
import {
  POST_CONTENT_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
} from "../../community/content/domain/textLimits";
import { SEARCH_TERM_MAX_LENGTH } from "../../community/content/domain/searchTerm";
import { MAX_PAGE_SIZE } from "../../community/shared/paging";
import {
  budgetedMember,
  communityStudentProcedure,
  mapDomainErrors,
} from "./procedures";

/**
 * Categories and posts.
 *
 * Reads are `communityStudentProcedure` — a signed-in student may browse
 * before choosing a handle. Writes are `budgetedMember`, which builds on the
 * member tier — so "eligible community user" stays a type rather than a check,
 * and the per-action cap stays a property of the procedure.
 *
 * The Zod caps match the column widths in `community.prisma`. That is the
 * point: these columns are `VARCHAR` and MySQL runs in strict mode, so an
 * oversized value throws rather than truncates, and a cap that did not match
 * would let the composer clear a user's text before the write failed.
 */
export const postsRouter = router({
  categories: communityStudentProcedure.query(({ ctx }) =>
    mapDomainErrors(() => ctx.community.posts.listCategories()),
  ),

  /**
   * `sort` is optional and absent means `"new"`, so a client written before
   * Top existed keeps the feed it had. The enum is the whole validation: an
   * unknown order is a client bug, not a value to fall back from silently.
   *
   * **`search` is a parameter here rather than a `posts.search` of its own**
   * (SCRUM-683). A search is the feed narrowed by a substring — same tier,
   * same cursor, same category filter, and above all the same visibility
   * rules — so a second procedure would be a second place to remember
   * `hiddenAt`, the block filter and the keyset. The cap is the domain's own
   * constant, so the schema here cannot drift from what the service enforces.
   */
  list: communityStudentProcedure
    .input(
      z
        .object({
          categorySlug: z.string().max(32).optional(),
          search: z.string().max(SEARCH_TERM_MAX_LENGTH).optional(),
          sort: z.enum(["new", "top"]).optional(),
          cursor: z.string().max(256).optional(),
          limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.posts.list(ctx.actor, input ?? {})),
    ),

  byId: communityStudentProcedure
    .input(z.object({ postId: z.string().min(1).max(64) }))
    .query(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.posts.byId(ctx.actor, input.postId)),
    ),

  create: budgetedMember("POST_CREATE")
    .input(
      z.object({
        categorySlug: z.string().min(1).max(32),
        title: z.string().max(POST_TITLE_MAX_LENGTH),
        content: z.string().max(POST_CONTENT_MAX_LENGTH),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.posts.create(ctx.actor, input)),
    ),

  /**
   * **No `categorySlug`** (spec §10): an edit rewrites the text and nothing
   * else. Accepting one here would let a post carry its votes, comments and
   * saves into a category whose readers never chose it.
   *
   * The author check is the service's and the repository's, not this
   * procedure's. `budgetedMember` can establish that the caller is a member
   * with budget left; it cannot know who wrote a row it has not read, so a
   * tier is the wrong place to put the question.
   */
  edit: budgetedMember("CONTENT_EDIT")
    .input(
      z.object({
        postId: z.string().min(1).max(64),
        title: z.string().max(POST_TITLE_MAX_LENGTH),
        content: z.string().max(POST_CONTENT_MAX_LENGTH),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.posts.edit(ctx.actor, input)),
    ),

  /**
   * The author's own soft delete, which is a different act from moderation's
   * hide and writes a different column (spec §8).
   *
   * **There is deliberately no moderator branch here.** Spec §10's table reads
   * "member + author, or moderator", but §8's rationale for keeping `deletedAt`
   * and `hiddenAt` apart is the stronger rule, and `moderation.review` is the
   * moderator's path — it sets `hiddenAt`, which is reversible and auditable.
   * A moderator reaching this procedure instead would record a moderation
   * decision as an author's deletion.
   */
  delete: budgetedMember("CONTENT_DELETE")
    .input(z.object({ postId: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.posts.delete(ctx.actor, input)),
    ),
});
