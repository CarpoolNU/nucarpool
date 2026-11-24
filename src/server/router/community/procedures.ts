import { TRPCError } from "@trpc/server";
import type { CommunityBudgetAction } from "@prisma/client";
import { protectedRouter } from "../createRouter";
import {
  requireMember,
  requireModerator,
  type CommunityActor,
  type Member,
  type Moderator,
} from "../../community/actor";
import type { BudgetService } from "../../community/budget/service";
import { resolveActor } from "./actorResolution";
import { runWithClaim } from "./budgetEnforcement";
import { toTRPCError } from "./errorMapping";

/**
 * The community procedure tiers.
 *
 * They extend NUCarpool's existing `protectedRouter`, so "is there a session"
 * stays the platform's answer and is not re-implemented here. What these add
 * is the tier: **reading requires a signed-in student, writing requires a
 * member** — someone who has claimed a handle — **and moderating requires a
 * moderator**.
 *
 * Resolving the actor once in middleware, rather than in each procedure, is
 * what makes the tier a property of the procedure's *type*: a handler built on
 * `communityMemberProcedure` receives a `Member`, so a policy function that
 * takes a `Member` cannot be called with someone who has no handle. The
 * moderator tier is the same argument one step further: a handler on
 * `communityModeratorProcedure` receives a `Moderator`.
 */

const withActor = protectedRouter.use(async ({ ctx, next }) => {
  const user = ctx.session?.user;
  // `?.id` because NUCarpool's `next-auth.d.ts` declares `id` optional. A
  // session that cannot name its user cannot name an actor either.
  if (!user?.id) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const profile = await ctx.community.profiles.profileRef(user.id);
  const actor = resolveActor(
    { id: user.id, permission: user.permission },
    profile,
  );

  return next({ ctx: { ...ctx, actor } });
});

/** Any signed-in student. Reads only. */
export const communityStudentProcedure = withActor;

/** Has claimed a handle. Every write path builds on this. */
export const communityMemberProcedure = withActor.use(({ ctx, next }) => {
  let member: Member;
  try {
    member = requireMember(ctx.actor satisfies CommunityActor);
  } catch (error) {
    return toTRPCError(error);
  }
  return next({ ctx: { ...ctx, actor: member } });
});

/**
 * Moderator-only. The two moderation procedures build on this.
 *
 * It narrows from the student-tier actor rather than from the member tier:
 * `requireModerator` takes any `CommunityActor`, and `resolveActor`
 * only yields a moderator for someone who already has a handle, so a member
 * step in front would add nothing. Anyone who is not a moderator, including a
 * student, is refused here as `FORBIDDEN` rather than given the handle prompt
 * `requireMember` gives: for a member, a handle is not the missing step.
 *
 * **The one exception is a platform admin who has not yet claimed a handle**,
 * and it is the only refusal in this file that names a remedy.
 * `resolveActor` makes them a `student`, so they are refused here although
 * claiming a handle would let them moderate — and "Only moderators can do
 * that." is false to exactly the person who sees it, since by the platform's
 * predicate they already are one. The tier does not move: it is still
 * `FORBIDDEN`, and a member still gets the refusal that names the rule,
 * because for a member there is no step to take.
 *
 * **Reading `permission` here is not a leak of the session downward.** This is
 * the transport layer, the one place that is allowed to know a session exists;
 * what it must not do is pass `permission` on, and it does not — only the
 * sentence changes, and `ctx.actor` is unchanged. The distinction cannot be
 * made from the actor alone, which collapses "admin without a handle" and
 * "student" into one `kind` by design.
 */
export const communityModeratorProcedure = withActor.use(({ ctx, next }) => {
  let moderator: Moderator;
  try {
    moderator = requireModerator(ctx.actor satisfies CommunityActor);
  } catch (error) {
    if (
      ctx.actor.kind === "student" &&
      ctx.session?.user !== undefined &&
      ctx.session.user.permission !== "USER"
    ) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Claim a community handle before moderating.",
      });
    }
    return toTRPCError(error);
  }
  return next({ ctx: { ...ctx, actor: moderator } });
});

/**
 * What `next()` resolves to, as much of it as this file needs.
 *
 * Deliberately structural rather than tRPC's own `MiddlewareResult`, which is
 * marked internal: the two properties below are the entire contract this cares
 * about, and a tier's concrete result type still flows through unchanged.
 */
type NextResult = { ok: true } | { ok: false; error: unknown };

/**
 * The shared middleware body: claim, run, map.
 *
 * **`next()` is turned back into a throw before `runWithClaim` sees it.** A tRPC
 * middleware's `next()` does not reject when the handler throws — it catches and
 * resolves `{ ok: false, error }`. Written the way the design's §4 writes it,
 * `try { return await next() } catch`, the refund arm would be unreachable and
 * every server fault would silently cost the caller a charge.
 *
 * **The refusal is mapped here, not thrown raw.** `runWithClaim` throws a
 * `RateLimitedError` so that it stays free of transport policy, but a domain
 * error leaving a middleware is wrapped as INTERNAL_SERVER_ERROR by tRPC — a
 * refused write would reach the client as a 500 rather than TOO_MANY_REQUESTS.
 * `toTRPCError` maps it and rethrows everything else untouched, so a genuine
 * fault still reaches NUCarpool's error masking unchanged. (The scaffold
 * `createRouter.ts` in this repo deliberately has none; the masking is the
 * merge target's, and that is where this matters.)
 */
const enforceBudget = async <TResult extends NextResult>(
  budgets: BudgetService,
  userId: string,
  action: CommunityBudgetAction,
  next: () => Promise<TResult>,
): Promise<TResult> => {
  const claim = await budgets.claim(userId, action);
  try {
    return await runWithClaim(claim, async () => {
      const result = await next();
      if (!result.ok) {
        throw result.error;
      }
      return result;
    });
  } catch (error) {
    return toTRPCError(error);
  }
};

/**
 * Budgeted tiers. The action is the only argument; its limit and window come
 * from `BUDGET_RULES`.
 *
 * **A budget is the same kind of fact as the actor**, so it is resolved in
 * middleware for the reason stated at the top of this file: it makes the cap a
 * property of the procedure rather than a check each handler has to remember,
 * and a write procedure that forgets it is visible here at the router instead
 * of silently unbounded. It also keeps every service free of a budget
 * dependency, so no existing service test needs a new fake.
 *
 * **Composed onto a tier rather than fixed to the member tier**, which corrects
 * the design's §4. §4 builds `budgeted` on `communityMemberProcedure` and §7
 * budgets the handle claim — but claiming a handle is *what makes someone a
 * member*, so that one procedure is and must remain student-tier. The guarantee
 * §4 actually wanted still holds: every `CommunityActor` carries a `userId`, and
 * all three tiers extend `protectedRouter`, so anonymous traffic never reaches
 * the budget table.
 *
 * **The two differ only in which tier they call `.use()` on**, and that is not
 * stylistic. Factoring the builder out behind a generic parameter widens
 * `ctx.actor` back to `CommunityActor`, because a generic body resolves `.use()`
 * against its constraint — which would quietly undo the member tier's whole
 * purpose and make `ctx.community.votes.vote(ctx.actor, …)` stop compiling.
 */
export const budgetedStudent = (action: CommunityBudgetAction) =>
  communityStudentProcedure.use(({ ctx, next }) =>
    enforceBudget(ctx.community.budgets, ctx.actor.userId, action, next),
  );

export const budgetedMember = (action: CommunityBudgetAction) =>
  communityMemberProcedure.use(({ ctx, next }) =>
    enforceBudget(ctx.community.budgets, ctx.actor.userId, action, next),
  );

/**
 * Runs a service call, translating domain errors at the boundary.
 *
 * Every procedure body goes through this, so `toTRPCError` is reached from one
 * place per procedure and a service can never leak a `DomainError` to the wire.
 */
export const mapDomainErrors = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    return toTRPCError(error);
  }
};
