/**
 * Measures what `user.messages.getUnreadMessageCount` actually costs (SCRUM-306).
 *
 * The ticket was filed on the shape of the generated SQL: four levels of nested
 * `IN` subqueries, the outermost a self-reference to `message` — the
 * fastest-growing table in the schema — filtered on a column carrying no index.
 * That description was accurate. What it did not establish was whether any of it
 * costs anything, which is what this script is for.
 *
 * It is **read-only** — `count`, `findFirst` and `EXPLAIN`, no writes of any kind
 * — and it never prints the connection string.
 *
 * ## Read the plan, not the clock
 *
 * The timings this prints are the least transferable thing in the output. A
 * developer's local database holds a handful of rows, so every query is fast and
 * the number means nothing; staging holds under a hundred messages, which is not
 * much better.
 *
 * The **plan** is different. `EXPLAIN` reports the access type MySQL chose for
 * each table — `eq_ref`, `ref`, `index_merge`, `ALL` — and those describe the
 * shape of the work rather than its current size. A plan that reaches `message`
 * by primary key stays a primary-key lookup at a million rows. A plan showing
 * `ALL` on `message` would be a scan that gets worse every day. That distinction
 * is the whole question this ticket asks, and it is answerable against a small
 * database, which is why the plan is printed first and in full.
 *
 * Usage:
 *   npx ts-node scripts/measure-unread-count.ts
 *   npx ts-node scripts/measure-unread-count.ts --user <userId>
 *   npx ts-node scripts/measure-unread-count.ts --runs 20
 *
 * Confirm DATABASE_URL points where you intend before running. Pointing it at
 * production is safe — nothing is written — and production is the only place the
 * timings mean anything.
 */

import { PrismaClient, Prisma } from "@prisma/client";

/** One row of MySQL's `EXPLAIN` output, as Vitess and MySQL 8 both return it. */
export type ExplainRow = {
  id: number | string | null;
  select_type: string | null;
  table: string | null;
  type: string | null;
  possible_keys: string | null;
  key: string | null;
  ref: string | null;
  rows: number | string | null;
  filtered: number | string | null;
  Extra: string | null;
};

/**
 * Access types that do not scale with table size, in the order MySQL considers
 * them best-to-worst. A plan built only from these is bounded by how many rows
 * the *caller* owns, not by how large the table has grown.
 */
const BOUNDED_ACCESS_TYPES = new Set([
  "system",
  "const",
  "eq_ref",
  "ref",
  "range",
  "index_merge",
  "ref_or_null",
  "unique_subquery",
  "index_subquery",
  "fulltext",
]);

/**
 * Access types that read a whole table or a whole index every time. These are
 * the ones that turn a fast query into a slow one purely by the table growing,
 * and the only ones for which adding an index is the answer.
 */
const SCANNING_ACCESS_TYPES = new Set(["ALL", "index"]);

export type PlanVerdict = {
  /** Rows whose access type scans, worst first. Empty is the good case. */
  scans: { table: string; type: string }[];
  /**
   * `DEPENDENT SUBQUERY` blocks. MySQL re-evaluates one of these per candidate
   * outer row rather than once, so they multiply rather than add — the actual
   * cost of deep nesting, as opposed to its appearance.
   */
  dependentSubqueries: string[];
  /** Product of the per-table row estimates: MySQL's guess at rows examined. */
  estimatedRowsExamined: number;
  /** True when nothing in the plan scans and nothing is re-evaluated per row. */
  bounded: boolean;
};

/**
 * Reduces an `EXPLAIN` to the three things that decide whether an index would
 * help: does anything scan, is anything re-evaluated per outer row, and how many
 * rows does the optimiser expect to examine in total.
 *
 * Unrecognised access types count as scanning. An unknown plan should read as a
 * problem to look at rather than silently as a clean bill of health.
 */
export const summarisePlan = (rows: ExplainRow[]): PlanVerdict => {
  const scans: { table: string; type: string }[] = [];
  const dependentSubqueries: string[] = [];
  let estimatedRowsExamined = 1;

  for (const row of rows) {
    const table = row.table ?? "(unnamed)";
    const type = row.type ?? "(none)";

    if (SCANNING_ACCESS_TYPES.has(type) || !BOUNDED_ACCESS_TYPES.has(type)) {
      scans.push({ table, type });
    }

    if ((row.select_type ?? "").toUpperCase().includes("DEPENDENT")) {
      dependentSubqueries.push(table);
    }

    const estimate = Number(row.rows ?? 1);
    estimatedRowsExamined *= Number.isFinite(estimate)
      ? Math.max(1, estimate)
      : 1;
  }

  return {
    scans,
    dependentSubqueries,
    estimatedRowsExamined,
    bounded: scans.length === 0 && dependentSubqueries.length === 0,
  };
};

/**
 * Nearest-rank percentile over an unsorted sample.
 *
 * Nearest-rank rather than interpolated because these are observed durations,
 * and reporting a p50 that no run actually took invites the reader to trust a
 * precision the sample does not have. A single run is its own p50 and p99.
 */
export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
};

export type Timings = { runs: number; p50: number; p99: number; mean: number };

export const summariseTimings = (durations: number[]): Timings => ({
  runs: durations.length,
  p50: percentile(durations, 50),
  p99: percentile(durations, 99),
  mean:
    durations.length === 0
      ? 0
      : durations.reduce((total, value) => total + value, 0) / durations.length,
});

/**
 * Whether the measurement justifies adding an index, and why.
 *
 * Deliberately opinionated rather than a bare dump of numbers. The ticket's
 * suggested criterion is "if warranted", and leaving that to whoever reads the
 * output invites the default answer — add the index, it cannot hurt — which is
 * wrong here for a specific reason the plan shows and a row count does not.
 *
 * `isRead` is a boolean: two distinct values across the whole table. An index on
 * a two-valued column can only ever help if the query *starts* from it, and this
 * one does not — it starts from the caller's `request` rows. Nothing changes that
 * except the optimiser choosing a different plan, which is what `bounded` tests.
 */
export const indexVerdict = (input: {
  plan: PlanVerdict;
  messageRows: number;
  rowsExaminedThreshold: number;
}): { warranted: boolean; reason: string } => {
  const { plan, messageRows, rowsExaminedThreshold } = input;

  if (plan.scans.length > 0) {
    const list = plan.scans.map((s) => `${s.table} (${s.type})`).join(", ");
    return {
      warranted: true,
      reason:
        `The plan scans: ${list}. A scan grows with the table, so this is the ` +
        `case an index is for. Index the column the scanning table is filtered ` +
        `on, and re-run to confirm the access type changed.`,
    };
  }

  if (plan.dependentSubqueries.length > 0) {
    return {
      warranted: true,
      reason:
        `The plan re-evaluates ${plan.dependentSubqueries.length} dependent ` +
        `subquery block(s) (${plan.dependentSubqueries.join(", ")}) once per ` +
        `outer row. Flattening the query is the first fix; an index on the ` +
        `subquery's join column is the second.`,
    };
  }

  if (plan.estimatedRowsExamined > rowsExaminedThreshold) {
    return {
      warranted: true,
      reason:
        `Every access is bounded, but the optimiser still expects to examine ` +
        `~${plan.estimatedRowsExamined} rows, over the ${rowsExaminedThreshold} ` +
        `threshold. The useful index here is a composite ` +
        `message(conversationId, isRead, userId), which makes the per-message ` +
        `primary-key lookup unnecessary by answering the filter from the index ` +
        `alone. Note this is NOT an index on isRead: see below.`,
    };
  }

  return {
    warranted: false,
    reason:
      `No index is warranted. Every table is reached by an index (nothing ` +
      `scans), no subquery is re-evaluated per row, and the optimiser expects ` +
      `~${plan.estimatedRowsExamined} rows examined against a ${messageRows}-row ` +
      `message table. Specifically, an index on isRead alone cannot help: the ` +
      `query reaches message by primary key (eq_ref), which is already the ` +
      `tightest access type MySQL has, and isRead holds two distinct values so ` +
      `it could not drive a selective lookup even if the plan started there. ` +
      `The composite (userId, isRead) the ticket floats is worse than useless: ` +
      `the predicate is userId != ?, a negation, which no index can range-scan.`,
  };
};

/**
 * `EXPLAIN`-able SQL for the count the procedure runs.
 *
 * Kept as literal SQL rather than generated from the Prisma call, because the
 * point is to inspect the plan and `EXPLAIN` needs a statement. It mirrors the
 * shape Prisma emits for `message.count({ where: { isRead, userId: { not },
 * conversation: { request: { some: { OR } } } } })` as of SCRUM-296 — verify it
 * still matches by comparing against the generated SQL this script logs above
 * it, which comes from the real Prisma call.
 */
export const explainableSql = (userId: string): string =>
  `SELECT COUNT(*) FROM (
     SELECT message.id FROM message
     WHERE message.isRead = false
       AND message.userId != ?
       AND message.id IN (
         SELECT t0.id FROM message AS t0
         INNER JOIN conversation AS j0 ON j0.id = t0.conversationId
         WHERE j0.id IN (
           SELECT t1.id FROM conversation AS t1
           INNER JOIN request AS j1 ON j1.conversationId = t1.id
           WHERE (j1.fromUserId = ? OR j1.toUserId = ?) AND t1.id IS NOT NULL
         ) AND t0.id IS NOT NULL
       )
   ) AS sub`.replace(/\?/g, `'${userId.replace(/'/g, "''")}'`);

/**
 * A user with unread mail, for when the caller did not name one.
 *
 * Exported so the selection is visible next to the measurement rather than
 * buried: which user you measure changes the answer, because the plan is driven
 * by how many requests that user is party to.
 */
export const findSubject = async (
  prisma: Pick<PrismaClient, "message">,
): Promise<string | undefined> => {
  const newest = await prisma.message.findFirst({
    where: { isRead: false },
    select: {
      userId: true,
      conversation: {
        select: { request: { select: { fromUserId: true, toUserId: true } } },
      },
    },
    orderBy: { dateCreated: "desc" },
  });

  const request = newest?.conversation?.request[0];
  if (!newest || !request) return undefined;

  return request.fromUserId === newest.userId
    ? request.toUserId
    : request.fromUserId;
};

/** The `where` `getUnreadMessageCount` builds, kept in one place. */
const unreadWhere = (userId: string): Prisma.MessageWhereInput => ({
  isRead: false,
  userId: { not: userId },
  conversation: {
    request: {
      some: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
    },
  },
});

const parseArgs = (argv: string[]) => {
  const userFlag = argv.indexOf("--user");
  const runsFlag = argv.indexOf("--runs");
  const runs = runsFlag === -1 ? 10 : Number(argv[runsFlag + 1]);
  return {
    requestedUserId: userFlag === -1 ? undefined : argv[userFlag + 1],
    runs: Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 10,
  };
};

const main = async () => {
  const { requestedUserId, runs } = parseArgs(process.argv.slice(2));

  const generatedSql: string[] = [];
  const prisma = new PrismaClient({
    log: [{ emit: "event", level: "query" }],
  });
  // The generated SQL is half the evidence in the ticket, and the only way to
  // see it is to ask Prisma. Captured rather than printed as it arrives, so the
  // measurement queries below do not interleave with it.
  prisma.$on("query" as never, (event: never) => {
    generatedSql.push((event as unknown as { query: string }).query);
  });

  try {
    // Prefer a user who actually has unread mail: measuring a user with no
    // conversations exercises the cheap short-circuit and says nothing.
    //
    // The subject is the *recipient*, so it is whichever end of the request did
    // not write the message. Picking `toUserId` unconditionally would half the
    // time measure the author, whose own message the badge excludes.
    const subjectId = requestedUserId ?? (await findSubject(prisma));

    if (!subjectId) {
      console.log(
        "No user with unread messages found. This database has nothing to measure;\n" +
          "pass --user <userId> to measure a specific account anyway.",
      );
      return;
    }

    const [messageRows, unreadRows, conversations, requests] =
      await Promise.all([
        prisma.message.count(),
        prisma.message.count({ where: { isRead: false } }),
        prisma.conversation.count(),
        prisma.request.count(),
      ]);

    console.log("=== dataset ===");
    console.log(`  message rows        : ${messageRows}`);
    console.log(`  unread              : ${unreadRows}`);
    console.log(`  conversation rows   : ${conversations}`);
    console.log(`  request rows        : ${requests}`);
    console.log(`  measured for user   : ${subjectId}`);
    console.log();

    generatedSql.length = 0;
    const badge = await prisma.message.count({ where: unreadWhere(subjectId) });
    const emitted = generatedSql[generatedSql.length - 1];

    console.log("=== generated SQL ===");
    console.log(`  badge value: ${badge}`);
    console.log(
      emitted ? `  ${emitted}` : "  (query logging produced nothing)",
    );
    console.log();

    // `$queryRawUnsafe` because EXPLAIN takes no parameters in the position we
    // need them; the id is interpolated by `explainableSql`, which quotes it.
    // The value comes from the database or from the operator's own argument, not
    // from user input, and nothing here is a write.
    const plan = (await prisma.$queryRawUnsafe(
      `EXPLAIN ${explainableSql(subjectId)}`,
    )) as ExplainRow[];

    console.log("=== EXPLAIN (the part that generalises) ===");
    for (const row of plan) {
      console.log(
        `  ${String(row.select_type ?? "").padEnd(20)} ${String(row.table ?? "").padEnd(10)} ` +
          `type=${String(row.type ?? "").padEnd(12)} key=${String(row.key ?? "(none)").padEnd(34)} ` +
          `rows=${String(row.rows ?? "")} ${row.Extra ?? ""}`,
      );
    }
    console.log();

    const verdict = summarisePlan(plan);
    console.log("=== plan summary ===");
    console.log(
      `  scanning accesses    : ${verdict.scans.length === 0 ? "none" : verdict.scans.map((s) => `${s.table} (${s.type})`).join(", ")}`,
    );
    console.log(
      `  dependent subqueries : ${verdict.dependentSubqueries.length === 0 ? "none" : verdict.dependentSubqueries.join(", ")}`,
    );
    console.log(`  est. rows examined   : ${verdict.estimatedRowsExamined}`);
    console.log(`  bounded by caller    : ${verdict.bounded ? "yes" : "NO"}`);
    console.log();

    const durations: number[] = [];
    for (let run = 0; run < runs; run += 1) {
      const started = process.hrtime.bigint();
      await prisma.message.count({ where: unreadWhere(subjectId) });
      durations.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    }
    const timings = summariseTimings(durations);

    console.log("=== timings (dataset-dependent; see the header) ===");
    console.log(`  runs  : ${timings.runs}`);
    console.log(`  p50   : ${timings.p50.toFixed(2)} ms`);
    console.log(`  p99   : ${timings.p99.toFixed(2)} ms`);
    console.log(`  mean  : ${timings.mean.toFixed(2)} ms`);
    console.log();

    const index = indexVerdict({
      plan: verdict,
      messageRows,
      rowsExaminedThreshold: 1000,
    });

    console.log("=== index verdict ===");
    console.log(`  warranted: ${index.warranted ? "YES" : "no"}`);
    console.log(`  ${index.reason}`);
    console.log();
    console.log(
      "Rows above are the optimiser's estimates, not counted reads. PlanetScale\n" +
        "bills examined rows and reports them per query pattern under Insights,\n" +
        "which is the authority for production and does not need this script --\n" +
        "see the SCRUM-306 section of src/server/db/README.md.",
    );
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
