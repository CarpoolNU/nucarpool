#!/usr/bin/env node
"use strict";

/**
 * Environment contract check.
 *
 * The application validates its environment with `envsafe` at import time in
 * src/utils/env/browser.ts and src/utils/env/server.ts. Those two modules are
 * the authoritative definition of what the app requires: when a variable is
 * missing there, the app throws during `next build` and at runtime.
 *
 * This script derives the required variable names from those modules, so the
 * list never has to be maintained by hand, and uses them for two purposes:
 *
 *   1. (default) Verify .env.example documents every required variable, so a
 *      newly added variable cannot land without being documented for the team.
 *   2. `--github-env` emits throwaway placeholder values for CI, so the build
 *      job can satisfy envsafe without any real credentials.
 *
 * Keeping both behaviours here is deliberate: the CI build placeholders and the
 * documentation check read the same derived list, so they cannot drift apart.
 *
 * Usage:
 *   node scripts/check-env-contract.js              # check .env.example
 *   node scripts/check-env-contract.js --verbose    # also name extra vars
 *   node scripts/check-env-contract.js --list       # print required names
 *   node scripts/check-env-contract.js --github-env >> "$GITHUB_ENV"
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const ENV_MODULES = [
  path.join(ROOT, "src", "utils", "env", "browser.ts"),
  path.join(ROOT, "src", "utils", "env", "server.ts"),
];

const ENV_EXAMPLE = path.join(ROOT, ".env.example");

/**
 * Provided by the platform or the CI runner, so they are never expected to be
 * documented in .env.example even if the env modules start reading them.
 */
const NOT_DEVELOPER_SUPPLIED = new Set(["NODE_ENV", "CI"]);

/**
 * Placeholder values for the CI build. Only variables whose *shape* gets parsed
 * by a library need an entry; anything else can be any non-empty string,
 * because envsafe's `str()` validator only requires presence.
 */
const PLACEHOLDER_OVERRIDES = {
  // Prisma 4 does not validate the datasource URL when PrismaClient is
  // constructed, only when it first connects, and a build never connects. A
  // well-formed URL is used anyway so the placeholder does not depend on that
  // laziness and stays obviously a connection string to anyone reading a log.
  DATABASE_URL: "mysql://ci:ci@127.0.0.1:3306/ci",

  // Constrained to an allow-list rather than any non-empty string,
  // so the generic placeholder would fail envsafe and take the
  // build job down with it. `production` is the value the deployed app uses,
  // which also keeps the CI build closest to the real one — and because
  // `next build` sets NODE_ENV=production, the devDefault does not apply here.
  NEXT_PUBLIC_ENV: "production",
};

const DEFAULT_PLACEHOLDER = "ci-placeholder-not-a-real-secret";

/**
 * Tripwire. If a refactor changes how the env modules are written, this check
 * could silently start extracting nothing and pass forever. Refuse to run a
 * check that weak rather than provide false assurance.
 */
const MIN_EXPECTED_VARS = 8;

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(2);
}

/**
 * @returns {Map<string, string>} required variable name -> module that reads it
 */
function requiredVars() {
  const found = new Map();

  for (const file of ENV_MODULES) {
    const rel = path.relative(ROOT, file);
    if (!fs.existsSync(file)) {
      fail(`env module not found: ${rel}`);
    }

    const src = fs.readFileSync(file, "utf8");

    if (!src.includes("envsafe(")) {
      fail(
        `${rel} no longer calls envsafe(). This check derives the environment ` +
          `contract from that call, so scripts/check-env-contract.js needs updating.`,
      );
    }

    const names = [...src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((name) => !NOT_DEVELOPER_SUPPLIED.has(name));

    if (names.length === 0) {
      fail(
        `${rel} reads no process.env.* variables, so the extractor is stale.`,
      );
    }

    for (const name of names) {
      if (!found.has(name)) {
        found.set(name, rel);
      }
    }
  }

  if (found.size < MIN_EXPECTED_VARS) {
    fail(
      `only ${found.size} environment variable(s) extracted from the env ` +
        `modules, expected at least ${MIN_EXPECTED_VARS}. Refusing to run a ` +
        `check this weak.`,
    );
  }

  return found;
}

/**
 * @returns {Set<string>} variable names declared in .env.example
 */
function declaredInExample() {
  if (!fs.existsSync(ENV_EXAMPLE)) {
    fail(
      ".env.example not found. It is the documented environment contract for " +
        "the team and is required by this check.",
    );
  }

  const declared = new Set();
  for (const line of fs.readFileSync(ENV_EXAMPLE, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) {
      declared.add(match[1]);
    }
  }
  return declared;
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (arg) => !["--check", "--verbose", "--list", "--github-env"].includes(arg),
  );
  if (unknown.length) {
    fail(`unknown argument(s): ${unknown.join(", ")}`);
  }

  const required = requiredVars();
  const names = [...required.keys()].sort();

  if (args.includes("--list")) {
    console.log(names.join("\n"));
    return;
  }

  if (args.includes("--github-env")) {
    for (const name of names) {
      const value = Object.prototype.hasOwnProperty.call(
        PLACEHOLDER_OVERRIDES,
        name,
      )
        ? PLACEHOLDER_OVERRIDES[name]
        : DEFAULT_PLACEHOLDER;
      console.log(`${name}=${value}`);
    }
    return;
  }

  const declared = declaredInExample();
  const missing = names.filter((name) => !declared.has(name));
  const extra = [...declared].filter((name) => !required.has(name)).sort();

  console.log(
    `${names.length} variable(s) required by src/utils/env/{browser,server}.ts`,
  );
  console.log(`${declared.size} variable(s) declared in .env.example`);

  if (extra.length) {
    // Not a failure: a variable may be read directly through process.env, or be
    // genuinely optional. Reviewing them for obsolescence is a human call.
    console.log(
      `${extra.length} declared variable(s) are not required by envsafe` +
        (args.includes("--verbose") ? ":" : " (run with --verbose to list)"),
    );
    if (args.includes("--verbose")) {
      for (const name of extra) {
        console.log(`    ${name}`);
      }
    }
  }

  if (missing.length) {
    console.error(
      `\n✖ ${missing.length} required variable(s) missing from .env.example:`,
    );
    for (const name of missing) {
      console.error(`    ${name}  (read by ${required.get(name)})`);
    }
    console.error(
      `\nAdd them to .env.example with a placeholder value so the team knows ` +
        `they are needed. The application throws at import time without them.`,
    );
    process.exit(1);
  }

  console.log("\n✓ .env.example documents every required variable.");
}

main();
