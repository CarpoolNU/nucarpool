import type { CommunityBudgetAction } from "@prisma/client";
import type { BudgetClaim, BudgetRepository } from "../budget/ports";

/**
 * In-memory `BudgetRepository`.
 *
 * **It reproduces the real semantics rather than merely counting**, in the way
 * `FakeVoteRepository`'s header describes for the unique pair. Two properties
 * are load-bearing, and a fake missing either one is not a fake of this
 * repository (spec §11):
 *
 *   - **The cap is checked in the same step as the increment.** In production
 *     that is the cap sitting in the `UPDATE`'s `WHERE`. A fake that
 *     incremented and then compared would pass a service that
 *     read-modify-writes, which is exactly the bug the real statement exists to
 *     prevent.
 *   - **`refund()` floors at zero.** In production that is `count > 0` in the
 *     refund's `WHERE`. Without the floor, a double refund would drive the
 *     count negative and hand out a free action later in the window — so a fake
 *     without it would let that bug through.
 *
 * What it deliberately does NOT reproduce is concurrency: this is a single
 * JavaScript thread, so it tests this module's logic and not InnoDB's row lock.
 * That gap is named in spec §11.1 and is not closed here.
 */
export class FakeBudgetRepository implements BudgetRepository {
  /** `userId|action|windowStartMs` → actions spent. */
  private readonly counts = new Map<string, number>();

  private nextClaimError: Error | undefined;

  private static key(
    userId: string,
    action: CommunityBudgetAction,
    windowStart: Date,
  ): string {
    return `${userId}|${action}|${windowStart.getTime()}`;
  }

  /**
   * Makes the next `claim` call reject.
   *
   * Exists so a test can exercise the fail-closed path (spec §6): the claim
   * statement itself throwing must refuse the write rather than admit it.
   */
  failNextClaim(error: Error): void {
    this.nextClaimError = error;
  }

  /** Actions spent in one bucket. Lets a test assert the floor and the key. */
  countFor(
    userId: string,
    action: CommunityBudgetAction,
    windowStart: Date,
  ): number {
    return (
      this.counts.get(FakeBudgetRepository.key(userId, action, windowStart)) ??
      0
    );
  }

  async claim(
    userId: string,
    action: CommunityBudgetAction,
    windowStart: Date,
    limit: number,
  ): Promise<BudgetClaim> {
    if (this.nextClaimError) {
      const error = this.nextClaimError;
      this.nextClaimError = undefined;
      throw error;
    }

    const key = FakeBudgetRepository.key(userId, action, windowStart);
    const spent = this.counts.get(key) ?? 0;

    // The cap and the increment are one step, as `count < limit` in the real
    // statement's WHERE makes them.
    if (spent >= limit) {
      return { claimed: false, refund: async () => undefined };
    }
    this.counts.set(key, spent + 1);

    return {
      claimed: true,
      refund: async () => {
        // Floored at zero, as `count > 0` does in production.
        this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 0) - 1));
      },
    };
  }
}
