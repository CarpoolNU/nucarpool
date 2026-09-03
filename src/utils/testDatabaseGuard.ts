/**
 * Safety guard for the database-integration test harness.
 *
 * [`src/testing/integrationDatabase.ts`](../testing/integrationDatabase.ts)
 * `TRUNCATE`s every table it finds, before every test. Pointed at the wrong
 * database that is unrecoverable from the application, and the two most likely
 * wrong databases are both easy to reach by accident:
 *
 *   - **a developer's own `nucarpool`**, which sits on the same host and the
 *     same port as the integration database and differs only in name;
 *   - **whatever `DATABASE_URL` happens to hold**, which in a shell with a
 *     populated `.env` is a real database and in CI is a placeholder.
 *
 * So the harness never reads `DATABASE_URL`. It reads `TEST_DATABASE_URL`, and
 * only after this module has approved it. The two variables are kept
 * completely separate, and this module refuses a `TEST_DATABASE_URL` that is
 * the same string as `DATABASE_URL`, or that resolves to the same database on
 * the same host and port.
 *
 * **There is deliberately no override.** `seedGuard.ts` has
 * `SEED_ALLOW_REMOTE` because seeding a shared branch is something a human
 * might one day legitimately need. Truncating one never is. An escape hatch
 * here would be set once, in a workflow file, by someone in a hurry — and then
 * it would be permanent and invisible. If a target is refused, the answer is
 * to change the target.
 *
 * Like `seedGuard.ts` this module is dependency-free and side-effect-free, so
 * the whole rule set is unit tested with no database and no Prisma client —
 * which matters, because the guard is the one component whose failure is
 * measured in other people's data. It shares that file's local-hostname
 * allowlist rather than keeping a second copy, so there is one place to extend
 * and no way for the two to drift apart.
 *
 * ## The rules, in the order they are applied
 *
 * A target is refused unless **every** one of these holds:
 *
 *  1. `TEST_DATABASE_URL` is set and not blank.
 *  2. It is not the same string as `DATABASE_URL`.
 *  3. It parses as a URL.
 *  4. Its scheme is `mysql:`.
 *  5. It has a hostname.
 *  6. That hostname, normalised, is in `LOCAL_HOSTNAMES`.
 *  7. It names a database (the URL has a path).
 *  8. That name percent-decodes.
 *  9. The decoded name is only `[A-Za-z0-9_-]`.
 * 10. The decoded name contains no forbidden substring.
 * 11. One of its `_`/`-` separated words is exactly `test`.
 * 12. It is not the same host, port and database as `DATABASE_URL`.
 *
 * Two of those deserve their reasoning spelled out, because both close a real
 * bypass rather than a theoretical one.
 *
 * **Why the name is decoded, and then restricted to a safe character set.**
 * `mysql:` is not a *special* scheme in the WHATWG URL standard, so Node
 * normalises far less of it than an `http:` URL: percent escapes in the path
 * are preserved verbatim. `mysql://localhost/%70roduction_test` therefore has
 * the pathname `/%70roduction_test`, which contains neither the substring
 * `prod` nor anything else disqualifying, while carrying the word `test` — so
 * a rule reading the raw path would **accept it**, and the driver would then
 * decode it and connect to `production_test`. The name is decoded exactly once,
 * because decoding once is what a driver does, and the result is then required
 * to be plain `[A-Za-z0-9_-]`. That charset is what retires the whole class:
 * anything still holding a `%`, a `/`, a dot or a space is refused without
 * having to reason about which escape it was.
 *
 * **Why a word and not a substring.** `test` appears inside `latest`,
 * `greatest` and `attestation`, so a substring test would accept
 * `production_latest`. The name is split on `_` and `-` and one of the parts
 * has to be exactly `test`. The forbidden list is the mirror image — those are
 * matched as substrings, so `prod` catches `production` and `stag` catches both
 * `stage` and `staging`, and they win even when a `test` word is present, which
 * is what refuses `staging_test`. Allowing is strict; refusing is broad. That
 * asymmetry is the point, and it is why the guard also refuses some names that
 * are in fact harmless — `nucarpooltest` has no delimiter, and a hostname
 * written with a trailing dot (`localhost.`) is a legitimate way to say
 * localhost that is not in the allowlist. Both fail closed, which is the
 * direction that costs an error message rather than a database.
 */

import { LOCAL_HOSTNAMES, normalizeHostname } from "./seedGuard";

/** Environment variable naming the disposable integration-test database. */
export const TEST_DATABASE_URL_ENV = "TEST_DATABASE_URL";

/** The variable the application reads, which this guard refuses to share. */
export const APP_DATABASE_URL_ENV = "DATABASE_URL";

/** The only scheme accepted. This project has one database engine. */
const REQUIRED_PROTOCOL = "mysql:";

/** What a decoded database name may be made of, and nothing else. */
const SAFE_DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

/** What separates the words of a database name. */
const NAME_WORD_DELIMITERS = /[_-]/;

/** The word one of those parts has to be, compared case-insensitively. */
export const REQUIRED_NAME_WORD = "test";

/**
 * Substrings that disqualify a database name outright, even next to `test`.
 *
 * Short stems on purpose: `prod` covers `prod` and `production`, `stag` covers
 * `stage` and `staging` — note that `staging` does *not* contain `stage`, so
 * the stem is doing real work rather than being a tidier spelling.
 */
export const FORBIDDEN_NAME_SUBSTRINGS: readonly string[] = [
  "prod",
  "stag",
  "live",
  "main",
];

/** So an omitted port compares equal to an explicit 3306. */
const DEFAULT_MYSQL_PORT = "3306";

export type TestDatabaseBlockReason =
  | "missing-url"
  | "shared-with-app-url"
  | "unparseable-url"
  | "wrong-protocol"
  | "empty-hostname"
  | "remote-host"
  | "missing-database-name"
  | "undecodable-database-name"
  | "unsafe-database-name"
  | "forbidden-database-name"
  | "name-not-marked-test"
  | "same-database-as-app";

export type AllowedTestDatabase = {
  allowed: true;
  hostname: string;
  databaseName: string;
};

export type TestDatabaseDecision =
  | AllowedTestDatabase
  | {
      allowed: false;
      hostname: string | null;
      databaseName: string | null;
      reason: TestDatabaseBlockReason;
    };

/**
 * The slice of the environment this guard reads. Deliberately not
 * `NodeJS.ProcessEnv`, which this repository augments with required keys that a
 * caller — or a test — has no reason to supply. Same reasoning as
 * `SeedEnvironment` in `seedGuard.ts`.
 */
export type TestGuardEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The database name a URL path names, decoded exactly once.
 *
 * Two distinct failures, kept apart because they need different advice:
 * `new URL("mysql://localhost")` has an empty pathname and names no database
 * at all, while `decodeURIComponent` throws `URIError` on a stray `%`. Decoded
 * once rather than repeatedly, because once is what a driver does — the
 * database a connection actually opens is the single-decoded form.
 */
const readDatabaseName = (
  pathname: string,
):
  | { ok: true; name: string }
  | { ok: false; reason: "missing" | "undecodable" } => {
  const raw = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (raw === "") {
    return { ok: false, reason: "missing" };
  }

  try {
    return { ok: true, name: decodeURIComponent(raw) };
  } catch {
    return { ok: false, reason: "undecodable" };
  }
};

/** The host, port and database a URL resolves to, or null if it does not parse. */
const targetOf = (
  url: string | undefined,
): { hostname: string; port: string; databaseName: string } | null => {
  if (url === undefined || url.trim() === "") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  const name = readDatabaseName(parsed.pathname);
  if (!name.ok) {
    return null;
  }

  return {
    hostname: normalizeHostname(parsed.hostname),
    port: parsed.port === "" ? DEFAULT_MYSQL_PORT : parsed.port,
    databaseName: name.name,
  };
};

/** True when one of the name's `_`/`-` separated words is exactly `test`. */
export const isMarkedAsTest = (databaseName: string): boolean =>
  databaseName
    .toLowerCase()
    .split(NAME_WORD_DELIMITERS)
    .includes(REQUIRED_NAME_WORD);

/** The first forbidden substring the name contains, or null. */
export const forbiddenSubstringIn = (databaseName: string): string | null => {
  const lowered = databaseName.toLowerCase();
  return (
    FORBIDDEN_NAME_SUBSTRINGS.find((word) => lowered.includes(word)) ?? null
  );
};

/**
 * Decides whether the integration harness may truncate `testDatabaseUrl`.
 *
 * Fails closed at every step: anything missing, unparseable or merely
 * unrecognised is refused rather than assumed safe.
 *
 * `appDatabaseUrl` is the application's own `DATABASE_URL`, passed in so the
 * two can be compared. When it is absent or does not parse, the comparison is
 * skipped rather than treated as a match — there is nothing to compare
 * against, and the eleven rules before it still have to pass.
 */
export const evaluateTestDatabaseTarget = (
  testDatabaseUrl: string | undefined,
  appDatabaseUrl?: string,
): TestDatabaseDecision => {
  const refuse = (
    reason: TestDatabaseBlockReason,
    hostname: string | null = null,
    databaseName: string | null = null,
  ): TestDatabaseDecision => ({
    allowed: false,
    hostname,
    databaseName,
    reason,
  });

  if (testDatabaseUrl === undefined || testDatabaseUrl.trim() === "") {
    return refuse("missing-url");
  }

  const candidate = testDatabaseUrl.trim();

  // Before parsing, because "you have not separated the two variables" is the
  // most actionable thing to say and needs no parse to say it.
  if (appDatabaseUrl !== undefined && candidate === appDatabaseUrl.trim()) {
    return refuse("shared-with-app-url");
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return refuse("unparseable-url");
  }

  // `new URL` lowercases the scheme even for a non-special one, so `MYSQL://`
  // arrives here as `mysql:` and needs no folding of its own.
  if (parsed.protocol !== REQUIRED_PROTOCOL) {
    return refuse("wrong-protocol");
  }

  if (parsed.hostname === "") {
    return refuse("empty-hostname");
  }

  // Credentials cannot smuggle a match: the WHATWG parser reads
  // `mysql://localhost:pw@evil.example.com/db` as the host
  // `evil.example.com`, exactly as `seedGuard.ts` documents.
  const hostname = normalizeHostname(parsed.hostname);
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    return refuse("remote-host", hostname);
  }

  const name = readDatabaseName(parsed.pathname);
  if (!name.ok) {
    return refuse(
      name.reason === "missing"
        ? "missing-database-name"
        : "undecodable-database-name",
      hostname,
    );
  }
  const databaseName = name.name;

  // Everything that survived decoding but is not a plain identifier: a
  // remaining `%`, a `/` that a `%2F` turned into, a dot, a space.
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    return refuse("unsafe-database-name", hostname, databaseName);
  }

  // Checked before the `test` word so that `staging_test` is reported as what
  // is wrong with it rather than as an unmarked name.
  if (forbiddenSubstringIn(databaseName) !== null) {
    return refuse("forbidden-database-name", hostname, databaseName);
  }

  if (!isMarkedAsTest(databaseName)) {
    return refuse("name-not-marked-test", hostname, databaseName);
  }

  // Last, because it is the only rule that depends on another variable: a
  // different connection string can still address one database, and running
  // the suite against the database the app is using would truncate it.
  const appTarget = targetOf(appDatabaseUrl);
  const testTarget = {
    hostname,
    port: parsed.port === "" ? DEFAULT_MYSQL_PORT : parsed.port,
    databaseName,
  };
  if (
    appTarget !== null &&
    appTarget.hostname === testTarget.hostname &&
    appTarget.port === testTarget.port &&
    appTarget.databaseName === testTarget.databaseName
  ) {
    return refuse("same-database-as-app", hostname, databaseName);
  }

  return { allowed: true, hostname, databaseName };
};

/**
 * Explains a refusal.
 *
 * **Never includes the connection string**, which holds a password — only the
 * hostname and database name it resolved to, both of which the operator needs
 * in order to fix the target and neither of which is a credential. Same rule
 * as `describeBlockedSeed`, and there is a test asserting a password put into
 * a refused URL does not appear in the output.
 */
export const describeBlockedTestDatabase = (
  decision: TestDatabaseDecision,
): string => {
  if (decision.allowed) {
    throw new Error(
      "describeBlockedTestDatabase called with an allowed decision",
    );
  }

  const allowedHosts = [...LOCAL_HOSTNAMES].join(", ");
  const consequence = [
    "The integration harness TRUNCATES every table it finds, before every",
    "test. Against any database holding real rows that is destructive and not",
    "recoverable from the application.",
  ].join("\n");

  const headline: Record<TestDatabaseBlockReason, string> = {
    "missing-url": `${TEST_DATABASE_URL_ENV} is not set.`,
    "shared-with-app-url":
      `${TEST_DATABASE_URL_ENV} is the same value as ${APP_DATABASE_URL_ENV}. ` +
      `The two are kept separate on purpose.`,
    "unparseable-url": `${TEST_DATABASE_URL_ENV} could not be parsed as a URL, so the target cannot be verified.`,
    "wrong-protocol": `${TEST_DATABASE_URL_ENV} is not a ${REQUIRED_PROTOCOL}// URL.`,
    "empty-hostname": `${TEST_DATABASE_URL_ENV} has no hostname, so the target cannot be verified.`,
    "remote-host": `${TEST_DATABASE_URL_ENV} points at the non-local host "${decision.hostname}".`,
    "missing-database-name": `${TEST_DATABASE_URL_ENV} names no database.`,
    "undecodable-database-name": `The database name in ${TEST_DATABASE_URL_ENV} is not valid percent-encoding.`,
    "unsafe-database-name": `The database name "${decision.databaseName}" contains characters outside A-Z, a-z, 0-9, _ and -.`,
    "forbidden-database-name": `The database name "${decision.databaseName}" looks like a real environment, not a test one.`,
    "name-not-marked-test": `The database name "${decision.databaseName}" is not marked as a test database.`,
    "same-database-as-app": `${TEST_DATABASE_URL_ENV} and ${APP_DATABASE_URL_ENV} address the same database ("${decision.databaseName}" on ${decision.hostname}).`,
  };

  const remedy: Record<TestDatabaseBlockReason, string> = {
    "missing-url": `Set ${TEST_DATABASE_URL_ENV} to a local, test-only database. See "Integration tests" in src/server/db/README.md.`,
    "shared-with-app-url": `Point ${TEST_DATABASE_URL_ENV} at a separate database whose name carries a "${REQUIRED_NAME_WORD}" word.`,
    "unparseable-url": `Correct ${TEST_DATABASE_URL_ENV} and re-run.`,
    "wrong-protocol": `Correct ${TEST_DATABASE_URL_ENV} and re-run.`,
    "empty-hostname": `Correct ${TEST_DATABASE_URL_ENV} and re-run.`,
    "remote-host":
      `Allowed hosts: ${allowedHosts}\n\n` +
      `There is no override. Staging and production are never valid targets ` +
      `for this suite, so point ${TEST_DATABASE_URL_ENV} at your local ` +
      `container instead.`,
    "missing-database-name": `Add the database to the end of ${TEST_DATABASE_URL_ENV}, for example mysql://root:pw@127.0.0.1:3306/nucarpool_test`,
    "undecodable-database-name": `Write the database name literally rather than percent-encoded.`,
    "unsafe-database-name": `Write the database name literally rather than percent-encoded.`,
    "forbidden-database-name":
      `Names containing ${FORBIDDEN_NAME_SUBSTRINGS.join(", ")} are refused ` +
      `even alongside "${REQUIRED_NAME_WORD}". Use a dedicated database such ` +
      `as nucarpool_test.`,
    "name-not-marked-test":
      `One of the name's _ or - separated words has to be exactly ` +
      `"${REQUIRED_NAME_WORD}" — nucarpool_test, not nucarpool.`,
    "same-database-as-app": `Create a separate database for the suite and point ${TEST_DATABASE_URL_ENV} at that.`,
  };

  return [
    "Refusing to run the integration test suite.",
    "",
    headline[decision.reason],
    "",
    consequence,
    "",
    remedy[decision.reason],
  ].join("\n");
};

/** Thrown when the guard refuses a target. */
export class TestDatabaseGuardError extends Error {
  readonly reason: TestDatabaseBlockReason;

  constructor(decision: Extract<TestDatabaseDecision, { allowed: false }>) {
    super(describeBlockedTestDatabase(decision));
    this.name = "TestDatabaseGuardError";
    this.reason = decision.reason;
  }
}

/**
 * Throws {@link TestDatabaseGuardError} unless the configured target is a
 * local, test-only database that the application is not using. Returns the
 * approved hostname and database name, which are safe to log.
 *
 * Call before opening a connection, and before anything that writes.
 */
export const assertTestDatabaseTarget = (
  env: TestGuardEnvironment = process.env,
): AllowedTestDatabase => {
  const decision = evaluateTestDatabaseTarget(
    env[TEST_DATABASE_URL_ENV],
    env[APP_DATABASE_URL_ENV],
  );

  if (!decision.allowed) {
    throw new TestDatabaseGuardError(decision);
  }

  return decision;
};
