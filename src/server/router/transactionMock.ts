/**
 * `$transaction` for the hand-rolled Prisma mocks in the router tests
 * (SCRUM-233).
 *
 * The router tests drive `appRouter.createCaller` against an in-memory fake
 * whose delegates mutate plain arrays and Maps. Once the procedures under test
 * wrap their writes in `prisma.$transaction`, that fake needs the method too —
 * but a pass-through that merely invokes the callback would make the tests green
 * while proving nothing, because the property worth asserting is that a failure
 * part-way through leaves *no* partial state.
 *
 * So this rolls back. `snapshot` captures the mock's state before the callback
 * runs and `restore` puts it back if the callback throws, which is the
 * observable behaviour a real transaction has. Deliberately not a general
 * transaction implementation: no isolation levels, no nesting, no concurrency.
 *
 * The callback receives the client *without* `$transaction`, matching Prisma,
 * whose `TransactionClient` omits it — so a test cannot accidentally pass
 * against nesting that would fail in production.
 *
 * Note this file is named `transactionMock.ts`, not `*.test.ts`, and lives
 * outside any `__tests__` directory, so Jest's default `testMatch` does not
 * collect it as an empty suite.
 */

/** Deep-copies the plain arrays, Maps and records these mocks hold. */
export const cloneState = <T>(value: T): T => {
  if (value instanceof Map) {
    return new Map(
      [...value.entries()].map(([key, entry]) => [key, cloneState(entry)]),
    ) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneState(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    // Dates are values here, not structures to walk into.
    if (value instanceof Date) {
      return new Date(value.getTime()) as unknown as T;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneState(entry)]),
    ) as unknown as T;
  }
  return value;
};

/**
 * Adds a rolling-back `$transaction` to a mock Prisma client.
 *
 * `snapshot` should return a copy of every container the delegates mutate;
 * `restore` should write those contents back in place. Restoring in place
 * matters because the delegates close over the original references.
 */
export const withTransaction = <TClient extends object, TSnapshot>(
  client: TClient,
  snapshot: () => TSnapshot,
  restore: (value: TSnapshot) => void,
): TClient & {
  $transaction: <R>(fn: (tx: TClient) => Promise<R>) => Promise<R>;
} => ({
  ...client,
  $transaction: async <R>(fn: (tx: TClient) => Promise<R>): Promise<R> => {
    const before = snapshot();
    try {
      return await fn(client);
    } catch (error) {
      restore(before);
      throw error;
    }
  },
});
