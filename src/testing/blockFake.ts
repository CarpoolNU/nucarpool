/**
 * An in-memory `block` delegate for the router tests' hand-rolled Prisma fakes.
 *
 * Every server path where two users meet now reads `block` through
 * `src/server/db/blocks.ts` (SCRUM-554), so every fake client that reaches one
 * needs this delegate. The default, no rows, is the state every pre-existing
 * test was written against: nobody has blocked anybody.
 *
 * It evaluates the `where` shapes `blocks.ts` actually sends and **throws on
 * any other shape** rather than guessing. A fake that answered "no rows" to a
 * query it did not understand would let an enforcement check pass vacuously,
 * so a change to the query has to update this file too.
 *
 * Named without `.test` so Jest does not collect it as a suite, like
 * `transactionMock.ts`.
 */

import type { BlockReader } from "../server/db/blocks";

export type BlockRow = { blockerId: string; blockedId: string };

type IdFilter = string | { in: string[] };

type Clause = { blockerId?: IdFilter; blockedId?: IdFilter };

const matchesId = (value: string, filter: IdFilter | undefined): boolean => {
  if (filter === undefined) return true;
  if (typeof filter === "string") return value === filter;
  if (filter && Array.isArray(filter.in)) return filter.in.includes(value);
  throw new Error(`blockFake: unsupported id filter ${JSON.stringify(filter)}`);
};

const matchesClause = (row: BlockRow, clause: Clause): boolean => {
  const keys = Object.keys(clause);
  if (keys.some((key) => key !== "blockerId" && key !== "blockedId")) {
    throw new Error(`blockFake: unsupported clause ${JSON.stringify(clause)}`);
  }
  return (
    matchesId(row.blockerId, clause.blockerId) &&
    matchesId(row.blockedId, clause.blockedId)
  );
};

const matchesWhere = (row: BlockRow, where: any): boolean => {
  if (where && Array.isArray(where.OR) && Object.keys(where).length === 1) {
    return where.OR.some((clause: Clause) => matchesClause(row, clause));
  }
  return matchesClause(row, where ?? {});
};

/**
 * `findFirst` and `findMany`, over a live array so a test can add or remove a
 * block between calls to show that unblocking restores what was hidden.
 */
export const fakeBlockDelegate = (rows: BlockRow[] = []) => ({
  rows,
  findFirst: jest.fn(async ({ where }: any = {}) => {
    const row = rows.find((candidate) => matchesWhere(candidate, where));
    return row ? { id: `${row.blockerId}->${row.blockedId}`, ...row } : null;
  }),
  findMany: jest.fn(async ({ where }: any = {}) =>
    rows
      .filter((candidate) => matchesWhere(candidate, where))
      .map((row) => ({ ...row })),
  ),
});

/**
 * The delegate as a `BlockReader`, for calling the helpers in `blocks.ts`
 * directly. The cast is only to Prisma's promise types; the fake's shape is
 * what those helpers call.
 */
export const fakeBlockReader = (rows: BlockRow[] = []) => {
  const block = fakeBlockDelegate(rows);
  return { block, reader: { block } as unknown as BlockReader };
};
