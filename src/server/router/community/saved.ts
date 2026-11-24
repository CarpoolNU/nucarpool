import { z } from "zod";
import { router } from "../createRouter";
import { MAX_PAGE_SIZE } from "../../community/shared/paging";
import {
  budgetedMember,
  communityMemberProcedure,
  mapDomainErrors,
} from "./procedures";

/**
 * Saved posts.
 *
 * **All three are member-only**, including the read (spec §10). Every other
 * read in this module is open to a signed-in `student`, because a feed is
 * something you browse before deciding to take part; a saved list is not — it
 * is a list that only exists once you have one, and the thing that creates it
 * is a write. A `student` reaching this meets the handle gate, which is a step
 * rather than a wall.
 *
 * **Two write procedures, not one toggle** (spec §10.1). Both are idempotent,
 * so a client that retries after a timeout repeats the user's intent instead
 * of inverting it — which a single `toggleSave` could not do, because the
 * retry would arrive as a second toggle and undo the first.
 *
 * **Both writes draw from one `SAVE` bucket**, for the reason `votes.ts` gives
 * for its pair: leaving `unsave` unbounded would make the save limit evadable
 * by alternating the two paths. The rate-limiting design left `SAVE` unwired on
 * the ground that saved posts did not exist; SCRUM-682 shipped them, so the cap
 * that design already specified now has a caller. The `list` read is
 * deliberately unbudgeted — it is a read, like every other read in the module.
 */
const postIdInput = z.object({ postId: z.string().min(1).max(64) });

export const savedRouter = router({
  save: budgetedMember("SAVE")
    .input(postIdInput)
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.saved.save(ctx.actor, input.postId)),
    ),

  unsave: budgetedMember("SAVE")
    .input(postIdInput)
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        ctx.community.saved.unsave(ctx.actor, input.postId),
      ),
    ),

  list: communityMemberProcedure
    .input(
      z
        .object({
          cursor: z.string().max(256).optional(),
          limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.saved.list(ctx.actor, input ?? {})),
    ),
});
