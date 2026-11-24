import { z } from "zod";
import { router } from "../createRouter";
import { HANDLE_MAX_LENGTH } from "../../community/identity/domain/handle";
import { MAX_PAGE_SIZE } from "../../community/shared/paging";
import {
  budgetedStudent,
  communityMemberProcedure,
  communityStudentProcedure,
  mapDomainErrors,
} from "./procedures";

/**
 * Claiming and reading community handles.
 *
 * **Zod bounds the input; the domain validates it.** The schema's only job is
 * to stop an unbounded string reaching the service — it caps length to the
 * column width and nothing else. Shape, charset, reserved words and
 * normalization all live in `identity/domain/handle.ts`, so the client and the
 * server cannot drift apart about what a handle is.
 *
 * **`create` is the one budgeted procedure on the student tier**, and it has to
 * be: a member is what claiming a handle *produces*, so budgeting this on the
 * member tier would gate it behind the thing it creates. See `procedures.ts`.
 *
 * **A `HANDLE_TAKEN` refusal keeps its charge.** The limit exists to bound
 * handle enumeration through *failed* claims (parent spec §8.2), so refunding a
 * failure would leave it bounding nothing — a loop could probe the whole
 * namespace for free and only ever pay for the one claim that succeeded. The
 * gate validates shape in the browser first, so a mistyped handle never spends
 * one of the five — see `handleGate.tsx`.
 *
 * **`byHandle` and `posts` are member-tier, unlike every other read in this
 * module** (spec §10). Browsing a feed is something you do before deciding to
 * take part; gathering one person's complete output is not. Requiring the
 * viewer to have claimed a handle makes the person doing the looking exactly
 * as identifiable within this community as the person being looked at, and
 * that symmetry is the justification for offering the page at all. A student
 * who reaches it meets the handle gate, which is a step rather than a wall.
 *
 * **Two procedures behind one page, split along a module boundary.** The
 * header is `identity`'s — a handle and a join month — and the list is
 * `content`'s. `content` already depends on `identity` to render handles; the
 * reverse edge would close a cycle, so the profile view is assembled by the
 * page rather than by a service that reaches across both. Both procedures
 * refuse through the same `requireVisibleProfile`, so the two cannot drift
 * into answering different questions about the same handle. Both are reads and
 * neither takes a budget, as no read in this module does.
 */
export const profilesRouter = router({
  me: communityStudentProcedure.query(({ ctx }) =>
    mapDomainErrors(() => ctx.community.profiles.me(ctx.actor)),
  ),

  create: budgetedStudent("HANDLE_CLAIM")
    .input(
      z.object({
        // Generous relative to HANDLE_MAX_LENGTH so an over-long handle is
        // refused by the domain with a message naming the limit, rather than
        // by Zod with a generic string error.
        handle: z.string().max(HANDLE_MAX_LENGTH * 4),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        ctx.community.profiles.create(ctx.actor, input.handle),
      ),
    ),

  /**
   * Somebody else's profile.
   *
   * **NOT_FOUND covers four cases and distinguishes none of them**: no such
   * handle, a handle nobody could claim, a handle belonging to someone the
   * viewer blocked, and one belonging to someone who blocked the viewer. A
   * FORBIDDEN here would confirm the handle exists, which is how a block list
   * becomes a partial handle-to-person map (spec §7.2).
   */
  byHandle: communityMemberProcedure
    .input(z.object({ handle: z.string().max(HANDLE_MAX_LENGTH * 4) }))
    .query(({ ctx, input }) =>
      mapDomainErrors(() =>
        ctx.community.profiles.byHandle(ctx.actor, input.handle),
      ),
    ),

  /**
   * That handle's posts, newest first.
   *
   * **Posts only.** There is no comment-history procedure here and none is
   * planned: a comment history reconstructs which threads a person was in and
   * when, across the whole board, which is a much stronger aggregation than a
   * list of what they chose to write. See `PostService.listByHandle`.
   */
  posts: communityMemberProcedure
    .input(
      z.object({
        handle: z.string().max(HANDLE_MAX_LENGTH * 4),
        cursor: z.string().max(256).optional(),
        limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.posts.listByHandle(ctx.actor, input)),
    ),
});
