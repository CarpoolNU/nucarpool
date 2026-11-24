import { z } from "zod";
import { router } from "../createRouter";
import { REVIEW_NOTE_MAX_LENGTH } from "../../community/moderation/domain/reportLimits";
import { MAX_PAGE_SIZE } from "../../community/shared/paging";
import { communityModeratorProcedure, mapDomainErrors } from "./procedures";

/**
 * The moderator's side of reports: the queue, and one-shot resolution.
 *
 * **These procedures are the API, not the interface.** Spec §16.2 puts the
 * real moderator UI in NUCarpool's `admin.tsx`, added at merge, and that page
 * is what will call `queue` and `review`. The standalone page that arrives in
 * a later task is a harness for exercising them while Community is developed
 * apart from the platform, not the product surface, so nothing here should be
 * shaped around what that page happens to need.
 *
 * **Both sit on `communityModeratorProcedure`**, so the handler receives a
 * `Moderator` and a non-moderator is refused as `FORBIDDEN` before any of this
 * runs. The service narrows again itself; see `ModerationService` for why.
 *
 * **Neither is budgeted, by construction.** `CommunityBudgetAction` has no
 * moderation member, so there is nothing for these procedures to claim
 * against, and adding one is a schema change this ticket deliberately does not
 * make. It is not a settled policy to defend. The load argument is why that is
 * acceptable: a moderator working through a backlog is the intended load, not
 * abuse, and the callers are the platform's own staff. The audit (§13.3) is
 * what covers the rest, and it is a record, not a cap: a flood of moderator
 * calls would be written down, not limited.
 *
 * **`queue` defaults to `OPEN`** in the service, so the input leaves `status`
 * optional rather than defaulting it here: one place decides what an unfiltered
 * queue means.
 */
export const moderationRouter = router({
  queue: communityModeratorProcedure
    .input(
      z
        .object({
          status: z.enum(["OPEN", "REVIEWED", "DISMISSED"]).optional(),
          cursor: z.string().max(256).optional(),
          limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
          /**
           * Narrows to the urgent reasons. **A boolean, not the reason
           * list**: which reasons are urgent is a product decision that lives
           * in `REPORT_URGENCY`, and letting a client send the set would move
           * it to the browser and let a caller define its own urgency. Left
           * optional and defaulted in the service, as `status` is, so one
           * place decides what an unfiltered queue means.
           */
          urgentOnly: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      mapDomainErrors(() =>
        ctx.community.moderation.queue(ctx.actor, input ?? {}),
      ),
    ),

  review: communityModeratorProcedure
    .input(
      z.object({
        reportId: z.string().min(1).max(64),
        action: z.enum(["HIDE", "DISMISS"]),
        note: z.string().max(REVIEW_NOTE_MAX_LENGTH).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.moderation.review(ctx.actor, input)),
    ),

  /**
   * Who the reported user is, on the platform.
   *
   * **A mutation although it reads nothing but a report.** tRPC's split is
   * about effects, not verbs, and this one has two: it unmasks a member, and
   * it writes two audit rows doing so. Declared as a query it would be
   * cacheable, prefetchable and — on the client this repo uses — refetched on
   * window focus, so a moderator who left the tab open would keep writing
   * disclosure records they did not ask for. The audit (§13.3) is only worth
   * reading if every row in it is a deliberate act.
   *
   * **The input is a report id and the response is a name and an email**, which
   * makes this the one procedure in Community that crosses the boundary §13.1
   * draws. `moderationWireShape.test.ts` pins both halves: the queue never
   * carries identity, and this carries only the reported party's.
   *
   * Unbudgeted, like its two neighbours above, and the note there applies
   * unchanged. Worth adding that the cap here is structural rather than
   * merely absent: a call needs a report id, and reports are filed by members
   * against real content, so there is no way to sweep the membership.
   */
  identify: communityModeratorProcedure
    .input(z.object({ reportId: z.string().min(1).max(64) }))
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        ctx.community.moderation.identify(ctx.actor, input),
      ),
    ),
});
