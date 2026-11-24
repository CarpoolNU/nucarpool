import { z } from "zod";
import { router } from "../createRouter";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../community/moderation/domain/reportLimits";
import { budgetedMember, mapDomainErrors } from "./procedures";

/**
 * Filing a report.
 *
 * **Member-only, and budgeted.** Reporting is a write that costs a moderator's
 * attention, so it is capped on arrival with `REPORT_CREATE` like every other
 * write path. The cap is what bounds mass-reporting; nothing here, or below,
 * needs to know who filed what to enforce it.
 *
 * **The input has no field for a snapshot, deliberately.** The evidence copy a
 * report carries is built server-side from the stored row, so a reporter
 * cannot submit the text their report will be judged against. Adding a
 * `contentSnapshot` here, even as an optional hint, would let someone file a
 * report whose evidence says whatever they want it to.
 *
 * **The reply is a bare acknowledgement.** What it does not say — whether this
 * report hid the content, how many others agree, whether it was already
 * reviewed — is the service's rule, and this layer returns it unchanged.
 */
export const reportsRouter = router({
  create: budgetedMember("REPORT_CREATE")
    .input(
      z.object({
        targetType: z.enum(["POST", "COMMENT"]),
        targetId: z.string().min(1).max(64),
        reason: z.enum([
          "HARASSMENT",
          "SPAM",
          "MISINFORMATION",
          "OFF_TOPIC",
          "SAFETY_CONCERN",
          "OTHER",
        ]),
        message: z.string().max(REPORT_MESSAGE_MAX_LENGTH).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      mapDomainErrors(() => ctx.community.reports.create(ctx.actor, input)),
    ),
});
