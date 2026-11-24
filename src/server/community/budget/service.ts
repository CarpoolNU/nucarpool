import type { CommunityBudgetAction } from "@prisma/client";
import type { CommunityHostPort } from "../host/CommunityHostPort";
import { BUDGET_RULES, budgetWindowStart } from "./policy";
import type { BudgetClaim, BudgetRepository } from "./ports";

/**
 * Resolves an action's rule, floors the clock to its bucket, and claims.
 *
 * It takes the clock from `CommunityHostPort` as every other service in this
 * module does — which is what that port's `now()` was put there for: window
 * flooring is a pure function of a `Date`, so it is tested with ordinary values
 * instead of fake timers.
 *
 * **It returns the claim rather than throwing on a refusal.** Throwing is the
 * middleware's job, because a refusal is a transport concern and a service that
 * threw here would be deciding transport policy — the same reason
 * `TRPCError` never appears below the transport layer. See spec §3.4.
 */
export class BudgetService {
  constructor(
    private readonly repository: BudgetRepository,
    private readonly host: CommunityHostPort,
  ) {}

  async claim(
    userId: string,
    action: CommunityBudgetAction,
  ): Promise<BudgetClaim> {
    const rule = BUDGET_RULES[action];
    const windowStart = budgetWindowStart(this.host.now(), rule.windowMs);
    return this.repository.claim(userId, action, windowStart, rule.limit);
  }
}
