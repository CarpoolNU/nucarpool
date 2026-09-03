/**
 * Lifecycle for the disposable database the integration suite runs against.
 *
 * The mocked suite (`yarn test`) proves what a hand-built Prisma double was
 * told to return. This one proves what MySQL actually does: whether a
 * `where`/`include`/`select` is even a valid query, whether the referential
 * actions that `relationMode = "prisma"` emulates behave as the schema says,
 * and whether a multi-step write really rolls back. SCRUM-263.
 *
 * ## This is test infrastructure, not application code
 *
 * It lives in `src/testing/` rather than under `src/server/` on purpose. It
 * `TRUNCATE`s tables and shells out to the Prisma CLI, and neither belongs
 * anywhere the application could reach it — the same boundary
 * `src/utils/seedGuard.ts` draws for itself, drawn here with a directory so it
 * is visible in an import path. Nothing under `src/pages/` or `src/server/`
 * may import this module.
 *
 * ## What it will and will not touch
 *
 * It reads `TEST_DATABASE_URL`. It **never** reads `DATABASE_URL`, and never
 * falls back to it. Every entry point below goes through
 * [`assertTestDatabaseTarget`](../utils/testDatabaseGuard.ts) first, which
 * refuses anything that is not a local host holding a database whose name
 * carries a `test` word — and refuses a `TEST_DATABASE_URL` that addresses the
 * same database as `DATABASE_URL`. There is no override. The connection string
 * is never logged; the hostname and database name are, because an operator
 * needs to see which database they just wiped and neither is a credential.
 *
 * ## `prisma migrate deploy` here is not a change to the deploy workflow
 *
 * `prepareIntegrationDatabase` runs `prisma migrate deploy` against the
 * disposable database named by `TEST_DATABASE_URL`, and against nothing else.
 * That is deliberate and it is the point of the suite: building the schema from
 * the committed migration history is what makes the history itself testable,
 * and it is how `tutorial_completed` would have been caught (SCRUM-227).
 *
 * **It does not mean this repository has adopted `prisma migrate deploy` for
 * shared environments.** PlanetScale is still changed by `prisma db push` to
 * staging followed by a Deploy Request promoting staging to `main`; nothing in
 * the deploy pipeline reads `prisma/migrations/`, and that separation is
 * intentional. See "Changing the schema" and "What migrations are for here,
 * and what they are not" in [the db README](../server/db/README.md). The guard
 * is what keeps the two apart mechanically rather than by convention: a
 * PlanetScale host cannot be a target, so this command cannot reach one.
 *
 * ## Isolation
 *
 * `jest.integration.setupAfterEnv.js` truncates **before every test**, so a
 * suite is order-independent and a failure leaves nothing behind for the next
 * one. The consequence for anyone writing a test here: build fixtures in
 * `beforeEach` or in the test body, never in `beforeAll` — a `beforeAll`
 * insert is truncated before the first test that would have used it.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";
import {
  TEST_DATABASE_URL_ENV,
  assertTestDatabaseTarget,
  type TestGuardEnvironment,
} from "../utils/testDatabaseGuard";

/** Prefix for this harness's log lines, matching the repository's convention. */
const LOG_PREFIX = "[integration-db]";

/**
 * The table that records this database as the harness's own.
 *
 * The third lock, and the only one that asks the database rather than the
 * connection string. The guard can tell that a name carries a `test` word; it
 * cannot tell whether the rows behind that name matter to somebody. A
 * developer whose own database happens to be called `nucarpool_test` passes
 * every rule in `testDatabaseGuard.ts` — and on a machine with MySQL running
 * on 127.0.0.1, which is the normal state of a development laptop, the host
 * rule is no obstacle either.
 *
 * So the harness claims a database before it touches one, and afterwards
 * refuses anything it did not claim. An empty database is claimable; a
 * database with tables and no marker is somebody else's and is refused. That
 * turns "is this safe to truncate?" into a property of the database's
 * contents, which cannot be got wrong by mistyping an environment variable.
 */
export const MARKER_TABLE = "_nucarpool_integration_marker";

/**
 * Tables that survive truncation.
 *
 * `_prisma_migrations` is Prisma's own bookkeeping. Truncating it would make
 * `migrate deploy` replay every migration into a database that already has the
 * schema, which fails on the first `CREATE TABLE` — so the suite would work
 * once and then never again until the database was dropped by hand.
 *
 * {@link MARKER_TABLE} survives because it is the claim itself. `TRUNCATE`
 * would leave the table in place and only empty it, so presence would still
 * hold — but the row says when the database was claimed, and that is worth
 * keeping for whoever is working out what wiped their data.
 */
export const PRESERVED_TABLES: ReadonlySet<string> = new Set([
  "_prisma_migrations",
  MARKER_TABLE,
]);

/**
 * What a table name may look like before it is interpolated into `TRUNCATE`.
 *
 * Table names come from `information_schema` in a database the guard has
 * already approved, so this is not the last line of defence against anything
 * realistic — but a name is the one thing here that reaches SQL as an
 * identifier rather than a bound parameter, and identifiers cannot be
 * parameterised. Refusing anything that is not a plain identifier costs
 * nothing. `_Favorites` is mixed case and underscore-prefixed, which is why the
 * pattern allows both.
 */
const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/;

export type ApprovedTarget = {
  hostname: string;
  databaseName: string;
  /** The connection string. Never log this. */
  url: string;
};

/**
 * The approved target, or a thrown `TestDatabaseGuardError` explaining why
 * there is not one. Every other export funnels through this.
 */
export const approvedIntegrationTarget = (
  env: TestGuardEnvironment = process.env,
): ApprovedTarget => {
  const { hostname, databaseName } = assertTestDatabaseTarget(env);

  // Non-null by construction: the guard rejects a missing or blank value, so
  // reaching this line means the variable is set.
  const url = (env[TEST_DATABASE_URL_ENV] as string).trim();

  return { hostname, databaseName, url };
};

/** Host and database only — safe to print, unlike the URL. */
export const describeApprovedTarget = (target: ApprovedTarget): string =>
  `database "${target.databaseName}" on ${target.hostname}`;

let client: PrismaClient | undefined;

/**
 * The one client the integration suite uses, bound explicitly to the approved
 * URL rather than to the ambient `DATABASE_URL`.
 *
 * Deliberately **not** the `prisma` singleton from `src/server/db/client.ts`.
 * That one resolves its connection from `DATABASE_URL` through the datasource
 * block, so a suite using it would truncate whatever the developer's `.env`
 * happens to point at — the exact accident the guard exists to prevent. Two
 * clients in the same process is a cost worth paying for that.
 *
 * Memoised so the truncation between tests and the tests themselves share one
 * connection pool, and so `disconnectIntegrationDatabase` has one thing to
 * close. Jest's test workers each have their own module registry, so this is
 * one client per worker — which is part of why the suite runs with
 * `maxWorkers: 1`.
 */
export const integrationPrisma = (): PrismaClient => {
  if (!client) {
    const target = approvedIntegrationTarget();
    client = new PrismaClient({
      datasources: { db: { url: target.url } },
      // Quieter than the application client's `["info", "warn", "error"]`:
      // a suite that truncates between tests would otherwise print pool
      // chatter around every test.
      log: ["warn", "error"],
    });
  }

  return client;
};

/**
 * Every base table in the approved database, `information_schema` being the
 * only source that can answer this correctly.
 *
 * Prisma's own model list cannot: `_Favorites` is the join table behind the
 * implicit many-to-many `User.favorites`, and Prisma exposes **no delegate**
 * for it. A truncation driven off the models would leave favourite rows
 * standing between tests, which is order-dependence of exactly the kind the
 * suite is supposed to rule out. Migration history has also created and later
 * dropped tables (`invitation`, `_userCarpools`), so a hand-written list would
 * rot; asking the database means it cannot.
 *
 * `DATABASE()` rather than an interpolated name, so the query is scoped to
 * whatever the connection is actually attached to and the name never reaches
 * SQL as text.
 */
export const discoverTables = async (
  prisma: Pick<PrismaClient, "$queryRawUnsafe">,
): Promise<string[]> => {
  const rows = await prisma.$queryRawUnsafe<{ tableName: string }[]>(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
  );

  return rows.map((row) => row.tableName);
};

/**
 * Empties every discovered table except {@link PRESERVED_TABLES}.
 *
 * Order is irrelevant, and that is a property of this schema rather than luck:
 * `relationMode = "prisma"` means Prisma emulates the foreign keys and MySQL
 * holds none, so there are no constraints for a truncation order to violate —
 * all 31 committed migrations contain zero `FOREIGN KEY` statements. Nothing
 * here disables `FOREIGN_KEY_CHECKS`, and it should not start: if a real
 * constraint is ever added, this failing loudly is the correct outcome.
 *
 * `TRUNCATE` rather than `DELETE` because it does not scan, and rather than
 * `prisma.$transaction` because MySQL commits implicitly around DDL anyway.
 */
export const truncateAll = async (
  prisma: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
): Promise<string[]> => {
  const tables = await discoverTables(prisma);
  const truncated: string[] = [];

  for (const table of tables) {
    if (PRESERVED_TABLES.has(table)) {
      continue;
    }

    if (!SAFE_TABLE_NAME.test(table)) {
      throw new Error(
        `${LOG_PREFIX} refusing to truncate a table whose name is not a plain ` +
          `identifier: ${JSON.stringify(table)}`,
      );
    }

    await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
    truncated.push(table);
  }

  return truncated;
};

export type ClaimOutcome =
  | { claimed: true; reason: "empty-database" | "already-claimed" }
  | { claimed: false; reason: "not-ours"; tables: string[] };

/**
 * Claims the database for the harness, or refuses to use it.
 *
 * Three cases, and the middle one is the whole point:
 *
 *   - **empty** — no tables at all, so nothing can be lost. Claimed, and the
 *     marker is written so later runs recognise it.
 *   - **already claimed** — the marker is there. Ours.
 *   - **anything else** — tables that this harness did not create. Refused,
 *     naming what it found.
 *
 * Called *before* `prisma migrate deploy`, not after, because `migrate deploy`
 * is itself a write: running it first would have created eleven tables in
 * somebody else's database before anything noticed.
 *
 * Note what this does **not** do: it never drops or empties anything to make a
 * database claimable. A refusal is for a human to resolve by choosing a
 * different database or dropping that one deliberately.
 */
export const claimIntegrationDatabase = async (
  prisma: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">,
): Promise<ClaimOutcome> => {
  const tables = await discoverTables(prisma);

  if (tables.includes(MARKER_TABLE)) {
    return { claimed: true, reason: "already-claimed" };
  }

  if (tables.length > 0) {
    return { claimed: false, reason: "not-ours", tables };
  }

  // Static SQL, no interpolation: the name is a constant in this file.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE \`${MARKER_TABLE}\` (
       claimed_at DATETIME(3) NOT NULL,
       note VARCHAR(255) NOT NULL
     )`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO \`${MARKER_TABLE}\` (claimed_at, note) VALUES (NOW(3), ?)`,
    "Claimed by the NUCarpool integration test harness (SCRUM-263). " +
      "Every table in this database is truncated between tests.",
  );

  return { claimed: true, reason: "empty-database" };
};

/** Explains a refused claim. Names tables, never a connection string. */
export const describeRefusedClaim = (
  target: ApprovedTarget,
  tables: readonly string[],
): string =>
  [
    `${LOG_PREFIX} refusing to use ${describeApprovedTarget(target)}.`,
    "",
    `It holds ${tables.length} table(s) that this harness did not create, so`,
    "it is somebody else's database - most likely a development one whose",
    `name happens to satisfy the guard. The harness only ever adopts an empty`,
    `database, and marks it with \`${MARKER_TABLE}\` when it does.`,
    "",
    `Found: ${tables.slice(0, 12).join(", ")}${tables.length > 12 ? ", ..." : ""}`,
    "",
    "Point TEST_DATABASE_URL at a database you are willing to lose, create it",
    "empty, and re-run. Nothing has been changed.",
  ].join("\n");

/** The `beforeEach` entry point. Empties the database the suite may use. */
export const resetIntegrationDatabase = async (): Promise<void> => {
  await truncateAll(integrationPrisma());
};

/**
 * Applies the committed migration history to the approved database.
 *
 * **Only ever the disposable integration database** — see the note at the top
 * of this file. `DATABASE_URL` is set in the child process's environment
 * alone, because the Prisma CLI resolves the datasource from it and this
 * process must not have it changed underneath the application client.
 *
 * Output is captured and printed only on failure. Prisma names the host and
 * database it connected to, never the password, so a failure is safe to show.
 */
export const applyIntegrationMigrations = (target: ApprovedTarget): void => {
  const prismaBin = path.resolve(
    __dirname,
    "..",
    "..",
    "node_modules",
    ".bin",
    "prisma",
  );

  if (!existsSync(prismaBin)) {
    throw new Error(
      `${LOG_PREFIX} the Prisma CLI is not installed at ${prismaBin}. ` +
        `Run yarn install.`,
    );
  }

  try {
    execFileSync(prismaBin, ["migrate", "deploy"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: target.url },
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string };
    throw new Error(
      [
        `${LOG_PREFIX} prisma migrate deploy failed against ` +
          `${describeApprovedTarget(target)}.`,
        details.stdout ?? "",
        details.stderr ?? "",
      ]
        .join("\n")
        .trim(),
    );
  }
};

/**
 * `globalSetup` for the integration config: approve the target, build its
 * schema from migration history, prove it is reachable, and leave it empty.
 *
 * Runs once in Jest's parent process, before any worker starts, so a bad
 * target produces one clear refusal rather than the same connection error once
 * per suite. Its client is disconnected here because the workers create their
 * own.
 */
export const prepareIntegrationDatabase = async (): Promise<void> => {
  const target = approvedIntegrationTarget();
  console.log(`${LOG_PREFIX} using ${describeApprovedTarget(target)}`);

  const prisma = integrationPrisma();
  try {
    // Reachability first, so an unreachable or missing database is one clear
    // message rather than a failure inside the claim.
    await prisma.$queryRawUnsafe("SELECT 1");

    const claim = await claimIntegrationDatabase(prisma);
    if (!claim.claimed) {
      throw new Error(describeRefusedClaim(target, claim.tables));
    }

    // Only now, with the database known to be ours, is a write allowed.
    applyIntegrationMigrations(target);

    const truncated = await truncateAll(prisma);
    console.log(
      `${LOG_PREFIX} ready (${claim.reason}); ${truncated.length} table(s) emptied`,
    );
  } finally {
    await prisma.$disconnect();
    client = undefined;
  }
};

/** Closes the worker's connection. Called from `afterAll`. */
export const disconnectIntegrationDatabase = async (): Promise<void> => {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
};
