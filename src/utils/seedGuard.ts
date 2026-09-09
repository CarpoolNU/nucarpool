/**
 * Safety guard for the destructive seed script.
 *
 * `prisma/seed.ts` deletes every row from seven tables before inserting generated
 * data, and it writes to whatever `DATABASE_URL` points at. Every path reaches
 * the same entry point — `yarn seed`, a bare `prisma db seed`, and a database
 * reset during `yarn db:schema` or `prisma migrate reset`, because Prisma runs
 * the configured seed command after a reset. The check therefore lives in the
 * script itself rather than in any one command, so no invocation path can skip
 * it. (A `yarn build:preview` script used to be a fourth; it was deleted for
 * force-pushing the schema and re-seeding, and the note here outlived it.)
 *
 * **There is no override, and that is the design.** `SEED_ALLOW_REMOTE=1` used
 * to turn the remote-host refusal off for any host, production included, on the
 * argument that seeding a shared branch was something a human might one day
 * legitimately need. Nothing in this repository ever set it, the one plausible
 * consumer was the deleted `build:preview`, and `CLAUDE.md` had already reduced
 * it to "must never be set to make something work" — which is a deletion
 * waiting to happen rather than a feature. A single environment variable
 * standing between a shell history entry and an unrecoverable production wipe
 * is not a trade worth keeping (SCRUM-410).
 *
 * This module is deliberately dependency-free and side-effect-free so it can be
 * unit tested without a database or a Prisma client. It is tooling, not
 * application code — nothing under `src/pages` or `src/server` should import it.
 */

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

export type SeedBlockReason =
  "missing-url" | "unparseable-url" | "empty-hostname" | "remote-host";

/**
 * `reason` is a single-member union rather than a bare marker, deliberately:
 * there was a second member (`"override"`) and callers switched on it. Keeping
 * the shape makes adding another way to say yes a visible, reviewed change to
 * this type rather than a quiet extra branch.
 */
export type AllowedSeedTarget = {
  allowed: true;
  hostname: string;
  reason: "local-host";
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

/**
 * Decides whether the seed script may run against `databaseUrl`.
 *
 * Fails closed: a missing or unparseable connection string is refused rather
 * than assumed local. There is exactly one way for this to return `allowed` —
 * a hostname in {@link LOCAL_HOSTNAMES} — and it takes no second argument that
 * could change that answer.
 *
 * Only the hostname is compared. Credentials cannot smuggle a match, because
 * `mysql://localhost:pw@evil.example.com/db` parses to hostname
 * `evil.example.com`, not `localhost`.
 */
export function evaluateSeedTarget(
  databaseUrl: string | undefined,
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
    "prisma/seed.ts DELETES every row from request, message, conversation,",
    "carpool_search, location, group and user before inserting generated data.",
    "Against a shared database this destroys real user data and is not",
    "recoverable from the app.",
  ].join("\n");

  const headline: Record<SeedBlockReason, string> = {
    "missing-url": "DATABASE_URL is not set, so the target cannot be verified.",
    "unparseable-url":
      "DATABASE_URL could not be parsed as a URL, so the target cannot be verified.",
    "empty-hostname":
      "DATABASE_URL has no hostname, so the target cannot be verified.",
    "remote-host": `DATABASE_URL points at the non-local host "${decision.hostname}".`,
  };

  // No remedy names a way to proceed against this host, because there is not
  // one. The only fix offered is pointing DATABASE_URL somewhere local.
  const remedy =
    decision.reason === "remote-host"
      ? [
          `Allowed hosts: ${allowed}`,
          "",
          "If this should have been your local Docker MySQL, correct DATABASE_URL and",
          "re-run. There is no override: seeding a non-local database is not",
          "supported by any flag or environment variable.",
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
  const decision = evaluateSeedTarget(env.DATABASE_URL);
  if (!decision.allowed) {
    throw new SeedGuardError(decision);
  }
  return decision;
}
