/**
 * Safety guard for the destructive seed script.
 *
 * `prisma/seed.ts` deletes every row from six tables before inserting generated
 * data, and it writes to whatever `DATABASE_URL` points at. Three commands reach
 * it — `yarn seed`, `yarn build:preview`, and a database reset during
 * `yarn db:schema`, because Prisma runs the configured seed command after a
 * reset. The check therefore lives in the script itself rather than in any one
 * command, so no invocation path can skip it.
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit tested without a database or a Prisma client. It is tooling, not
 * application code — nothing under `src/pages` or `src/server` should import it.
 */

/** Environment variable that deliberately permits seeding a non-local host. */
export const SEED_OVERRIDE_ENV = "SEED_ALLOW_REMOTE";

/**
 * Hosts the seed script may wipe. Default deny: anything absent from this set is
 * refused. Extend this set — it is the single place the allowlist is defined.
 *
 * `mysql` and `mysql-on-docker` are the Compose service and container names, for
 * a seed run issued from inside the Compose network rather than from the host.
 */
export const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "mysql",
  "mysql-on-docker",
]);

/** Values of {@link SEED_OVERRIDE_ENV} that count as opting in. */
const OVERRIDE_ENABLED_VALUES: ReadonlySet<string> = new Set(["1", "true"]);

export type SeedBlockReason =
  | "missing-url"
  | "unparseable-url"
  | "empty-hostname"
  | "remote-host";

export type AllowedSeedTarget = {
  allowed: true;
  hostname: string;
  reason: "local-host" | "override";
};

export type SeedTargetDecision =
  | AllowedSeedTarget
  | { allowed: false; hostname: string | null; reason: SeedBlockReason };

/**
 * The WHATWG URL parser keeps IPv6 literals bracketed (`[::1]`), and hostnames
 * are case-insensitive, so both are normalised before the allowlist comparison.
 */
export function normalizeHostname(hostname: string): string {
  const unbracketed =
    hostname.length > 1 && hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return unbracketed.toLowerCase();
}

/** True only for an explicit, recognised opt-in value. */
export function isOverrideEnabled(value: string | undefined): boolean {
  return (
    value !== undefined &&
    OVERRIDE_ENABLED_VALUES.has(value.trim().toLowerCase())
  );
}

/**
 * Decides whether the seed script may run against `databaseUrl`.
 *
 * Fails closed: a missing or unparseable connection string is refused rather
 * than assumed local, and the override only ever relaxes the *remote host*
 * decision — it cannot authorise a target we were unable to identify.
 *
 * Only the hostname is compared. Credentials cannot smuggle a match, because
 * `mysql://localhost:pw@evil.example.com/db` parses to hostname
 * `evil.example.com`, not `localhost`.
 */
export function evaluateSeedTarget(
  databaseUrl: string | undefined,
  overrideValue?: string,
): SeedTargetDecision {
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    return { allowed: false, hostname: null, reason: "missing-url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { allowed: false, hostname: null, reason: "unparseable-url" };
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (hostname === "") {
    return { allowed: false, hostname: null, reason: "empty-hostname" };
  }

  if (LOCAL_HOSTNAMES.has(hostname)) {
    return { allowed: true, hostname, reason: "local-host" };
  }

  if (isOverrideEnabled(overrideValue)) {
    return { allowed: true, hostname, reason: "override" };
  }

  return { allowed: false, hostname, reason: "remote-host" };
}

/**
 * Explains a refusal. Never includes the connection string itself, which holds
 * credentials — only the hostname it resolved to.
 */
export function describeBlockedSeed(decision: SeedTargetDecision): string {
  if (decision.allowed) {
    throw new Error("describeBlockedSeed called with an allowed decision");
  }

  const allowed = [...LOCAL_HOSTNAMES].join(", ");
  const consequence = [
    "prisma/seed.ts DELETES every row from request, carpool_search, location,",
    "group, message and user before inserting generated data. Against a shared",
    "database this destroys real user data and is not recoverable from the app.",
  ].join("\n");

  const headline: Record<SeedBlockReason, string> = {
    "missing-url": "DATABASE_URL is not set, so the target cannot be verified.",
    "unparseable-url":
      "DATABASE_URL could not be parsed as a URL, so the target cannot be verified.",
    "empty-hostname":
      "DATABASE_URL has no hostname, so the target cannot be verified.",
    "remote-host": `DATABASE_URL points at the non-local host "${decision.hostname}".`,
  };

  const remedy =
    decision.reason === "remote-host"
      ? [
          `Allowed hosts: ${allowed}`,
          "",
          "If this should have been your local Docker MySQL, correct DATABASE_URL and",
          "re-run. If you genuinely intend to seed this host, opt in for that one",
          `command: ${SEED_OVERRIDE_ENV}=1 yarn seed`,
        ].join("\n")
      : [
          `Set DATABASE_URL to your local database before seeding. Allowed hosts: ${allowed}`,
        ].join("\n");

  return [
    "Refusing to seed.",
    "",
    headline[decision.reason],
    "",
    consequence,
    "",
    remedy,
  ].join("\n");
}

/** Thrown when the guard refuses a seed run. */
export class SeedGuardError extends Error {
  readonly reason: SeedBlockReason;

  constructor(decision: Extract<SeedTargetDecision, { allowed: false }>) {
    super(describeBlockedSeed(decision));
    this.name = "SeedGuardError";
    this.reason = decision.reason;
  }
}

/**
 * The slice of the environment this guard reads. Deliberately not
 * `NodeJS.ProcessEnv`, which this repository augments with required keys that a
 * caller (or a test) has no reason to supply.
 */
export type SeedEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Throws {@link SeedGuardError} unless the configured database is a local one.
 * Call before the first destructive statement.
 */
export function assertSeedTargetIsLocal(
  env: SeedEnvironment = process.env,
): AllowedSeedTarget {
  const decision = evaluateSeedTarget(env.DATABASE_URL, env[SEED_OVERRIDE_ENV]);
  if (!decision.allowed) {
    throw new SeedGuardError(decision);
  }
  return decision;
}
