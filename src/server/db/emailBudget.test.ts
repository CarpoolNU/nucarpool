import {
  budgetWindowStart,
  claimEmailBudget,
  EMAIL_BUDGET_WINDOW_MS,
  EMAILS_PER_BUDGET_WINDOW,
  type EmailBudgetStore,
} from "./emailBudget";

/**
 * The budget helper's branch logic and the shape of the statements it runs.
 *
 * What this file can establish: that a zero-row claim is reported as a
 * refusal, that a refused claim's `refund` writes nothing, and — the reason
 * the structural assertions below exist — that the cap stays in the `WHERE`
 * rather than migrating into an `IF()` on the assignment.
 *
 * What it cannot: whether MySQL actually reports zero rows for a claim at the
 * cap, or whether concurrent claims serialise. Those are server behaviours and
 * live in `src/server/router/user/emailBudget.db.test.ts`. A fake returns
 * whatever it is told to, so a test here asserting "only the cap gets through"
 * would only be asserting that this file can count.
 */

/** Records every statement, and answers each with the next queued value. */
const fakeStore = (answers: number[]) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  let next = 0;
  const $executeRaw = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    statements.push({ sql: strings.join("?"), values });
    return Promise.resolve(answers[next++] ?? 0);
  }) as unknown as EmailBudgetStore["$executeRaw"];
  return { store: { $executeRaw } as EmailBudgetStore, statements };
};

describe("budgetWindowStart", () => {
  it("floors to the start of the window", () => {
    expect(
      budgetWindowStart(new Date("2026-09-30T14:37:12.345Z")).toISOString(),
    ).toBe("2026-09-30T14:00:00.000Z");
  });

  it("is stable across every instant inside one window", () => {
    const base = new Date("2026-09-30T14:00:00.000Z").getTime();
    const first = budgetWindowStart(new Date(base));
    const last = budgetWindowStart(new Date(base + EMAIL_BUDGET_WINDOW_MS - 1));
    expect(last).toEqual(first);
  });

  it("moves to the next window at the boundary", () => {
    const base = new Date("2026-09-30T14:00:00.000Z").getTime();
    expect(
      budgetWindowStart(new Date(base + EMAIL_BUDGET_WINDOW_MS)).toISOString(),
    ).toBe("2026-09-30T15:00:00.000Z");
  });
});

describe("claimEmailBudget", () => {
  const NOW = new Date("2026-09-30T14:37:00.000Z");
  const WINDOW = new Date("2026-09-30T14:00:00.000Z");

  it("reports a claim when the conditional UPDATE changed a row", async () => {
    const { store } = fakeStore([1, 1]);
    await expect(
      claimEmailBudget(store, "u1", NOW).then((c) => c.claimed),
    ).resolves.toBe(true);
  });

  it("reports a refusal when the conditional UPDATE changed nothing", async () => {
    const { store } = fakeStore([1, 0]);
    await expect(
      claimEmailBudget(store, "u1", NOW).then((c) => c.claimed),
    ).resolves.toBe(false);
  });

  it("writes nothing when refunding a refused claim", async () => {
    const { store, statements } = fakeStore([1, 0]);
    const claim = await claimEmailBudget(store, "u1", NOW);
    const before = statements.length;

    await claim.refund();

    // A caller may call `refund` on its failure path without checking, so
    // this must not issue a decrement against a send that was never taken.
    expect(statements).toHaveLength(before);
  });

  it("decrements on refunding a successful claim, floored at zero", async () => {
    const { store, statements } = fakeStore([1, 1, 1]);
    const claim = await claimEmailBudget(store, "u1", NOW);

    await claim.refund();

    const refund = statements[2]!;
    expect(refund.sql).toContain("`send_count` = `send_count` - 1");
    expect(refund.sql).toContain("`send_count` > 0");
    expect(refund.values).toEqual(["u1", WINDOW]);
  });

  it("addresses the bucket by sender and floored window", async () => {
    const { store, statements } = fakeStore([1, 1]);
    await claimEmailBudget(store, "u1", NOW);

    // Both statements name the same bucket, so the row the claim increments
    // is the row the insert guaranteed.
    expect(statements[0]!.values).toEqual(["u1", WINDOW]);
    expect(statements[1]!.values).toEqual([
      "u1",
      WINDOW,
      EMAILS_PER_BUDGET_WINDOW,
    ]);
  });

  /**
   * A structural guard, not a behavioural one.
   *
   * The one-statement form — `SET send_count = IF(send_count < cap, send_count
   * + 1, send_count)` — is the tempting simplification and it is unsafe: it
   * always matches the row, so distinguishing a claim from a refusal would
   * depend on the client reporting changed rows rather than matched rows,
   * which `CLIENT_FOUND_ROWS` switches. Nothing else in the suite would notice
   * the swap, because the db test's server has the flag off and would keep
   * passing. So the shape is asserted here directly.
   */
  it("keeps the cap in the WHERE and not in the assignment", async () => {
    const { store, statements } = fakeStore([1, 1]);
    await claimEmailBudget(store, "u1", NOW);

    const insert = statements[0]!;
    const claim = statements[1]!;

    expect(insert.sql).toContain("ON DUPLICATE KEY UPDATE");
    // The insert must not disturb an existing count.
    expect(insert.sql).toContain("`user_id` = `user_id`");

    expect(claim.sql).toContain("`send_count` = `send_count` + 1");
    expect(claim.sql).toContain("`send_count` < ?");
    expect(claim.sql).not.toContain("IF(");
  });

  it("defaults the window to now", async () => {
    const { store, statements } = fakeStore([1, 1]);
    await claimEmailBudget(store, "u1");

    const [, windowStart] = statements[1]!.values as [string, Date, number];
    expect(windowStart).toEqual(budgetWindowStart(new Date()));
  });
});
