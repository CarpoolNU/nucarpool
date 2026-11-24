import type { CommunityBudgetAction } from "@prisma/client";
import type { BudgetClaim, BudgetRepository } from "./ports";

/**
 * The Prisma surface this needs, narrow so a test's in-memory store would only
 * have to supply `$executeRaw`. Both the base client and a transaction client
 * satisfy it.
 */
export type BudgetStore = {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
};

/**
 * The atomic claim, ported from `src/server/db/emailBudget.ts` in the host
 * repository — which is in production and whose four load-bearing decisions all
 * carry across (spec §3.3):
 *
 *   1. **Two statements, and only the second has to be atomic.** The first
 *      materialises the bucket and deliberately changes nothing if it is
 *      already there: `user_id = user_id` is the standard no-op assignment. Of
 *      two concurrent callers one inserts and the other hits the primary key
 *      and no-ops, so it cannot reset or double-count a bucket, and it is
 *      idempotent for the same reason.
 *   2. **The cap is in the `WHERE`, never in an `IF()` on the assignment.**
 *      Written as `SET count = IF(count < limit, count + 1, count)` the
 *      `UPDATE` always *matches* the row and only sometimes *changes* it, so
 *      telling a claim from a refusal would depend on whether the client
 *      reports matched or changed rows — which is exactly what
 *      `CLIENT_FOUND_ROWS` switches, and is not a flag this code should bet on.
 *      With the cap in the `WHERE`, a spent budget does not match at all and
 *      both readings agree.
 *   3. **`$executeRaw`, never `updateMany`.** Under `relationMode = "prisma"`
 *      `updateMany` reads the matching ids first and then updates by id, so
 *      concurrent callers all read the row before any of them changes it and
 *      every one reports `count: 1`. This was established against a real MySQL
 *      for `claimRequestNotification`, `markRequestAccepted` and `reserveSeat`.
 *   4. **`refund()` is guarded by `count > 0`**, so it can never drive the
 *      count negative and hand out a free action later in the window, and is a
 *      no-op on a refused claim so callers may call it unconditionally.
 *
 * The one difference from `emailBudget.ts` is the three-column primary key
 * `(user_id, action, window_start)`, so `action` appears in every statement.
 * The enum goes in as its string value; Prisma stores MySQL enums as strings.
 *
 * **Raw column names, not Prisma field names**, because raw SQL bypasses
 * `@map` entirely: `community_action_budget`, not `communityActionBudget`.
 *
 * **What no test here can prove.** The correctness argument above rests on
 * InnoDB serialising concurrent claims on one row's lock so that exactly
 * `limit` of them succeed. A fake cannot exercise that, so after this work the
 * limits are written and reviewed, not proven under concurrency. That gap is
 * spec §11.1, and it is recorded rather than closed.
 */
export class PrismaBudgetRepository implements BudgetRepository {
  constructor(private readonly store: BudgetStore) {}

  async claim(
    userId: string,
    action: CommunityBudgetAction,
    windowStart: Date,
    limit: number,
  ): Promise<BudgetClaim> {
    await this.store.$executeRaw`
      INSERT INTO \`community_action_budget\` (\`user_id\`, \`action\`, \`window_start\`, \`count\`)
      VALUES (${userId}, ${action}, ${windowStart}, 0)
      ON DUPLICATE KEY UPDATE \`user_id\` = \`user_id\`
    `;

    const claimed = await this.store.$executeRaw`
      UPDATE \`community_action_budget\`
      SET \`count\` = \`count\` + 1
      WHERE \`user_id\` = ${userId}
        AND \`action\` = ${action}
        AND \`window_start\` = ${windowStart}
        AND \`count\` < ${limit}
    `;

    if (claimed === 0) {
      return { claimed: false, refund: async () => undefined };
    }

    return {
      claimed: true,
      refund: async () => {
        await this.store.$executeRaw`
          UPDATE \`community_action_budget\`
          SET \`count\` = \`count\` - 1
          WHERE \`user_id\` = ${userId}
            AND \`action\` = ${action}
            AND \`window_start\` = ${windowStart}
            AND \`count\` > 0
        `;
      },
    };
  }
}
