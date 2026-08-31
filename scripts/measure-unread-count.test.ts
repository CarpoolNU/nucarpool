import {
  ExplainRow,
  explainableSql,
  findSubject,
  indexVerdict,
  percentile,
  summarisePlan,
  summariseTimings,
} from "./measure-unread-count";

/**
 * The reasoning behind the unread-badge measurement, tested for the same reason
 * as `measure-candidate-rows.test.ts` and `measure-requests-payload.test.ts`:
 * this script's output is quoted in the db README as the evidence for
 * *not* adding an index, and a verdict function that reaches the comfortable
 * answer by accident is worse than no verdict at all.
 *
 * `summarisePlan` and `indexVerdict` carry the weight. Everything the script
 * concludes comes from those two, so they are tested against the plans the
 * database actually returned — before and after the fix — rather than against
 * invented ones.
 */

const row = (overrides: Partial<ExplainRow>): ExplainRow => ({
  id: 1,
  select_type: "SIMPLE",
  table: "message",
  type: "eq_ref",
  possible_keys: "PRIMARY",
  key: "PRIMARY",
  ref: "t0.id",
  rows: 1,
  filtered: 100,
  Extra: null,
  ...overrides,
});

/**
 * The plan MySQL returned for the current query, captured from the PlanetScale
 * staging branch on 2026-08-31. Trimmed to the columns this script reads.
 */
const CURRENT_PLAN: ExplainRow[] = [
  row({
    table: "j1",
    type: "index_merge",
    key: "request_fromUserId_idx,request_toUserId_idx",
    rows: 2,
    Extra: "Using union(...); Using where; Start temporary",
  }),
  row({
    table: "j0",
    type: "eq_ref",
    key: "PRIMARY",
    rows: 1,
    Extra: "Using index",
  }),
  row({
    table: "t1",
    type: "eq_ref",
    key: "PRIMARY",
    rows: 1,
    Extra: "Using index",
  }),
  row({
    table: "t0",
    type: "ref",
    key: "message_conversationId_idx",
    rows: 2,
    Extra: "Using index",
  }),
  row({
    table: "message",
    type: "eq_ref",
    key: "PRIMARY",
    rows: 1,
    Extra: "Using where",
  }),
];

/**
 * The plan for the same query *before* the counterpart-role predicate was
 * removed, captured the same way. The two `DEPENDENT SUBQUERY` blocks are the
 * difference that mattered.
 */
const LEGACY_PLAN: ExplainRow[] = [
  ...CURRENT_PLAN.map((r) => row({ ...r, select_type: "PRIMARY" })),
  row({
    id: 7,
    select_type: "DEPENDENT SUBQUERY",
    table: "t2",
    type: "eq_ref",
    rows: 1,
  }),
  row({
    id: 7,
    select_type: "DEPENDENT SUBQUERY",
    table: "j2",
    type: "eq_ref",
    rows: 1,
  }),
  row({
    id: 7,
    select_type: "DEPENDENT SUBQUERY",
    table: "t3",
    type: "eq_ref",
    rows: 1,
  }),
  row({
    id: 7,
    select_type: "DEPENDENT SUBQUERY",
    table: "j3",
    type: "ref",
    key: "carpool_search_userId_idx",
    rows: 1,
    Extra: "Using where; FirstMatch(t3)",
  }),
];

describe("summarisePlan", () => {
  it("calls the current plan bounded: nothing scans, nothing repeats per row", () => {
    const verdict = summarisePlan(CURRENT_PLAN);

    expect(verdict.scans).toEqual([]);
    expect(verdict.dependentSubqueries).toEqual([]);
    expect(verdict.bounded).toBe(true);
    // 2 (request) x 1 x 1 x 2 (messages per conversation) x 1
    expect(verdict.estimatedRowsExamined).toBe(4);
  });

  it("flags the older plan for its dependent subqueries", () => {
    const verdict = summarisePlan(LEGACY_PLAN);

    // Not a scan anywhere - which is precisely why "no index on isRead" was
    // never the real problem. The cost was the re-evaluated blocks.
    expect(verdict.scans).toEqual([]);
    expect(verdict.dependentSubqueries).toEqual(["t2", "j2", "t3", "j3"]);
    expect(verdict.bounded).toBe(false);
  });

  it("flags a full table scan on message", () => {
    const verdict = summarisePlan([
      row({ table: "message", type: "ALL", key: null, rows: 250000 }),
    ]);

    expect(verdict.scans).toEqual([{ table: "message", type: "ALL" }]);
    expect(verdict.bounded).toBe(false);
  });

  it("treats a full index scan as scanning, not as an index being used", () => {
    // `type: index` reads the whole index. It says "an index was touched",
    // which is easy to misread as "the index helped".
    expect(summarisePlan([row({ type: "index" })]).scans).toEqual([
      { table: "message", type: "index" },
    ]);
  });

  it("treats an unrecognised access type as scanning rather than as clean", () => {
    // Failing closed. A plan this script does not understand must not read as a
    // clean bill of health.
    const verdict = summarisePlan([row({ type: "something_new" })]);

    expect(verdict.scans).toEqual([
      { table: "message", type: "something_new" },
    ]);
    expect(verdict.bounded).toBe(false);
  });

  it("treats a missing access type as scanning", () => {
    expect(summarisePlan([row({ type: null })]).bounded).toBe(false);
  });

  it("multiplies row estimates rather than adding them", () => {
    // A nested loop examines the product, not the sum. Adding would understate
    // a deep plan by orders of magnitude, which is the mistake that would make
    // this script agree with any query at all.
    const verdict = summarisePlan([
      row({ table: "a", rows: 10 }),
      row({ table: "b", rows: 20 }),
      row({ table: "c", rows: 30 }),
    ]);

    expect(verdict.estimatedRowsExamined).toBe(6000);
  });

  it("floors a zero or null row estimate at one", () => {
    // MySQL reports 0 for an empty table. Multiplying by it would collapse the
    // whole product to zero and declare a deep plan free.
    expect(
      summarisePlan([row({ rows: 0 }), row({ rows: 500 }), row({ rows: null })])
        .estimatedRowsExamined,
    ).toBe(500);
  });

  it("returns the empty-plan case without throwing", () => {
    const verdict = summarisePlan([]);

    expect(verdict.bounded).toBe(true);
    expect(verdict.estimatedRowsExamined).toBe(1);
  });

  it("handles the string row counts the driver actually returns", () => {
    // Vitess returns EXPLAIN numerics as strings over the wire.
    expect(
      summarisePlan([row({ rows: "2" }), row({ rows: "3" })])
        .estimatedRowsExamined,
    ).toBe(6);
  });
});

describe("indexVerdict", () => {
  const base = { messageRows: 94, rowsExaminedThreshold: 1000 };

  it("says no index is warranted for the current plan", () => {
    const verdict = indexVerdict({
      ...base,
      plan: summarisePlan(CURRENT_PLAN),
    });

    expect(verdict.warranted).toBe(false);
    // The reason has to name the mechanism, not just the conclusion.
    expect(verdict.reason).toContain("primary key");
    expect(verdict.reason).toContain("negation");
  });

  it("recommends flattening, not indexing, for a dependent subquery", () => {
    const verdict = indexVerdict({ ...base, plan: summarisePlan(LEGACY_PLAN) });

    expect(verdict.warranted).toBe(true);
    expect(verdict.reason).toContain("Flattening");
  });

  it("recommends an index when the plan scans", () => {
    const verdict = indexVerdict({
      ...base,
      plan: summarisePlan([
        row({ table: "message", type: "ALL", rows: 250000 }),
      ]),
    });

    expect(verdict.warranted).toBe(true);
    expect(verdict.reason).toContain("message (ALL)");
  });

  it("recommends the composite - never isRead alone - once rows examined grow", () => {
    // The one case where an index becomes the answer while the plan is still
    // fully indexed. It must not recommend the column the ticket guessed at.
    const verdict = indexVerdict({
      ...base,
      plan: summarisePlan([
        row({ table: "j1", type: "ref", rows: 40 }),
        row({ rows: 60 }),
      ]),
    });

    expect(verdict.warranted).toBe(true);
    expect(verdict.reason).toContain("message(conversationId, isRead, userId)");
    expect(verdict.reason).toContain("NOT an index on isRead");
  });

  it("does not trip the threshold at exactly the threshold", () => {
    expect(
      indexVerdict({
        ...base,
        plan: summarisePlan([row({ rows: 1000 })]),
      }).warranted,
    ).toBe(false);
  });

  it("prefers the scan diagnosis over the row-count one", () => {
    // A scanning plan and a large estimate arrive together. The scan is the
    // actionable fact; reporting the generic row-count advice would send the
    // reader to the wrong index.
    const verdict = indexVerdict({
      ...base,
      plan: summarisePlan([
        row({ table: "message", type: "ALL", rows: 250000 }),
      ]),
    });

    expect(verdict.reason).toContain("scans");
    expect(verdict.reason).not.toContain("conversationId, isRead, userId");
  });
});

describe("percentile", () => {
  it("uses nearest rank, so it only ever reports an observed value", () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(sample).toContain(percentile(sample, 50));
    expect(percentile(sample, 50)).toBe(5);
    expect(percentile(sample, 99)).toBe(10);
    expect(percentile(sample, 100)).toBe(10);
  });

  it("sorts before ranking", () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
  });

  it("makes a single run its own p50 and p99", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("returns zero for an empty sample rather than NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("clamps a zero percentile to the first element", () => {
    expect(percentile([3, 1, 2], 0)).toBe(1);
  });
});

describe("summariseTimings", () => {
  it("reports the run count alongside the percentiles", () => {
    // Without the count, a p99 drawn from three runs reads like a p99 drawn
    // from a thousand.
    const timings = summariseTimings([4, 2, 6]);

    expect(timings).toEqual({ runs: 3, p50: 4, p99: 6, mean: 4 });
  });

  it("survives an empty sample", () => {
    expect(summariseTimings([])).toEqual({ runs: 0, p50: 0, p99: 0, mean: 0 });
  });
});

describe("explainableSql", () => {
  it("keeps the shape whose plan is being measured", () => {
    const sql = explainableSql("user-1");

    expect(sql).toContain("message.isRead = false");
    expect(sql).toContain("message.userId != 'user-1'");
    // Both ends of the request, or the plan measured is not the one that runs.
    expect(sql).toContain("j1.fromUserId = 'user-1'");
    expect(sql).toContain("j1.toUserId = 'user-1'");
  });

  it("substitutes every placeholder", () => {
    expect(explainableSql("user-1")).not.toContain("?");
  });

  it("escapes a quote in the id rather than emitting broken SQL", () => {
    // The id comes from the database or an operator's own --user argument, so
    // this is robustness rather than a security boundary. It still must not
    // silently produce a statement that means something else.
    expect(explainableSql("o'brien")).toContain("'o''brien'");
  });
});

describe("findSubject", () => {
  const message = (
    userId: string,
    request: { fromUserId: string; toUserId: string }[],
  ) => ({ userId, conversation: { request } });

  const prismaWith = (result: unknown) =>
    ({
      message: { findFirst: jest.fn().mockResolvedValue(result) },
    }) as never;

  it("picks the recipient when the sender is the request's from-user", async () => {
    await expect(
      findSubject(
        prismaWith(
          message("alice", [{ fromUserId: "alice", toUserId: "bob" }]),
        ),
      ),
    ).resolves.toBe("bob");
  });

  it("picks the recipient when the sender is the request's to-user", async () => {
    // The half the naive version got wrong: a reply from the request's
    // recipient would have measured the author, whose own messages the badge
    // excludes, so the measurement would have run against a guaranteed zero.
    await expect(
      findSubject(
        prismaWith(message("bob", [{ fromUserId: "alice", toUserId: "bob" }])),
      ),
    ).resolves.toBe("alice");
  });

  it("returns undefined when there is no unread message", async () => {
    await expect(findSubject(prismaWith(null))).resolves.toBeUndefined();
  });

  it("returns undefined for a conversation with no request row", async () => {
    await expect(
      findSubject(prismaWith(message("alice", []))),
    ).resolves.toBeUndefined();
  });
});
