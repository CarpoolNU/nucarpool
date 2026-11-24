import { z } from "zod";
import { router } from "../createRouter";
import { budgetedMember, mapDomainErrors } from "./procedures";

/**
 * Upvotes.
 *
 * **Two procedures, not one toggle** (spec §10.1). Both are member-only and
 * both are idempotent, so a client that retries after a timeout repeats the
 * user's intent instead of inverting it — which a single `toggleVote` could not
 * do, because the retry would arrive as a second toggle and undo the first.
 *
 * Both return the post's new count and the caller's own state, so a client can
 * render the result without refetching the feed.
 *
 * **Both draw from one `VOTE` bucket**, which is a documented deviation from
 * parent spec §8.2 — its table names `VOTE` and says nothing about `unvote`.
 * Taken literally that leaves `unvote` — a write that takes a row lock and
 * decrements a counter — completely unbounded, which would make the vote limit
 * trivially evadable: a loop alternating the two paths would be capped on one
 * and free on the other. Sharing the bucket means a vote-then-unvote cycle
 * spends two, so a hundred cycles an hour exhausts it — far above any human and
 * far below a useful flood.
 */
const postIdInput = z.object({ postId: z.string().min(1).max(64) });

export const votesRouter = router({
  vote: budgetedMember("VOTE")
    .input(postIdInput)
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.votes.vote(ctx.actor, input.postId)),
    ),

  unvote: budgetedMember("VOTE")
    .input(postIdInput)
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        ctx.community.votes.unvote(ctx.actor, input.postId),
      ),
    ),
});
