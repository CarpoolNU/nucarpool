import type { CommunityBudgetAction } from "@prisma/client";

/**
 * The storage interface the budget needs, and nothing more.
 *
 * **The repository takes an already-floored `windowStart` and an
 * already-resolved `limit`.** Policy lives in `policy.ts`; this layer only
 * executes. That is what lets a limit be retuned without touching SQL, and the
 * SQL be read and reviewed without reasoning about window arithmetic. See the
 * rate-limiting spec, §3.2.
 */

export type BudgetClaim = {
  /** Whether this call got an action. `false` means the budget is spent. */
  claimed: boolean;
  /**
   * Gives the action back.
   *
   * **Safe to call once**, which is upstream `emailBudget.ts`'s wording and is
   * the honest claim. A no-op on a refused claim, so a caller may call it
   * unconditionally on its failure path.
   *
   * The floor at zero is a weaker guarantee than it looks: it stops one
   * caller's bucket going negative, but it does not make a second refund
   * harmless. Two callers each holding a claim leaves the count at two, so one
   * of them refunding twice returns the *other's* charge and hands out a free
   * action in that window. Nothing enforces single-use; there is one call site
   * (`runWithClaim`), and it is reached once per claim.
   */
  refund: () => Promise<void>;
};

export interface BudgetRepository {
  /**
   * Takes one action from this user's bucket for `windowStart`.
   *
   * Must enforce the cap *in the same step as the increment*. An
   * implementation that reads the count, compares, then writes is not an
   * implementation of this interface: two concurrent callers would both read a
   * spent-but-one bucket and both be granted.
   */
  claim(
    userId: string,
    action: CommunityBudgetAction,
    windowStart: Date,
    limit: number,
  ): Promise<BudgetClaim>;
}
