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
 * list never has to be maintained by hand, and uses them for three purposes:
 *
 *   1. (default) Verify .env.example documents every required variable, so a
 *      newly added variable cannot land without being documented for the team.
 *   2. `--github-env` emits throwaway placeholder values for CI, so the build
 *      job can satisfy envsafe without any real credentials.
 *   3. `--amplify` verifies amplify.yml carries every required variable into
 *      the deployed runtime environment (SCRUM-385).
 *
 * Keeping all three here is deliberate: the CI build placeholders, the
 * documentation check and the deploy-spec check read the same derived list, so
 * they cannot drift apart.
 *
 * **.env.example and amplify.yml are two different contracts.** The first is
 * what a developer has to put in their `.env`; the second is what the deployed
 * container actually gets. Before `--amplify` existed only the first was
 * checked, so a newly required variable could pass all seven CI checks and
 * simply be absent in production - which is what happened to `S3_BUCKET_NAME`.
 *
 * Usage:
 *   node scripts/check-env-contract.js              # check .env.example
 *   node scripts/check-env-contract.js --verbose    # also name extra vars
 *   node scripts/check-env-contract.js --list       # print required names
 *   node scripts/check-env-contract.js --github-env >> "$GITHUB_ENV"
 *   node scripts/check-env-contract.js --amplify    # check amplify.yml
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const ENV_MODULES = [
  path.join(ROOT, "src", "utils", "env", "browser.ts"),
  path.join(ROOT, "src", "utils", "env", "server.ts"),
];

const ENV_EXAMPLE = path.join(ROOT, ".env.example");

const AMPLIFY_SPEC = path.join(ROOT, "amplify.yml");

/**
 * The file amplify.yml's build phase appends the container environment to, and
 * which `envsafe` then reads. Matching on this rather than on "any grep line"
 * keeps the parser pointed at the lines that actually populate the runtime
 * environment.
 */
const ENV_PRODUCTION_FILE = ".env.production";

/**
 * Variables that do not need to appear in .env.production, and why.
 *
 * **Empty, and the better outcome.** amplify.yml carries every required
 * variable, including `NEXT_PUBLIC_*` - which is AWS's own documented example
 * and is deliberately preferred over exempting them.
 *
 * The tempting exemption was a `NEXT_PUBLIC_` prefix rule: Next replaces a
 * static `process.env.NEXT_PUBLIC_X` reference with its literal value at build
 * time, in the server compilation as well as the client one, so nothing reads
 * it from the environment at runtime. That is true of both such variables this
 * app has, because `src/utils/env/browser.ts` writes them literally. It would
 * stop being true for one read through a computed key - and an exemption whose
 * correctness depends on how a module happens to be written is exactly the
 * kind of implicit reasoning SCRUM-385 was filed about. A grep pattern costs
 * one line and needs no argument.
 *
 * The mechanism stays for the case that genuinely needs it. An exemption here
 * is reviewable; a variable missing from both this and the grep patterns is
 * the gap that let `S3_BUCKET_NAME` resolve to the console value at build time
 * and to `carpoolnubucket` at runtime with nothing erroring.
 *
 * @type {Record<string, string>} variable name -> reason it need not be copied
 */
const AMPLIFY_EXEMPT = {};

/**
 * Tripwire, in the same spirit as MIN_EXPECTED_VARS below. If amplify.yml is
 * restructured and the parser stops recognising the grep lines, this check
 * would find nothing uncovered and pass forever.
 */
const MIN_EXPECTED_AMPLIFY_PATTERNS = 5;

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
 * The options object of the `envsafe` validator that a `process.env.X`
 * reference sits inside.
 *
 * Every reference in those modules has the form
 * `NAME: validator({ input: process.env.NAME, ... })`, so the nearest
 * enclosing brace pair is the validator's options - which is where `default`
 * and `devDefault` live. Walked with a brace counter rather than matched with a
 * regular expression because the options span several lines and contain commas
 * and nested calls.
 *
 * Returns null when no enclosing pair can be found. The caller treats that as
 * a hard failure rather than guessing a classification: guessing "required"
 * for a defaulted variable is exactly the bug this function exists to fix
 * (SCRUM-397), and guessing "optional" for a mandatory one would drop a
 * genuine deploy check.
 *
 * @param {string} src
 * @param {number} index offset of the `process.env.X` reference
 * @returns {string | null} the text between the enclosing braces
 */
function envsafeOptionsAt(src, index) {
  let depth = 0;
  let open = -1;

  for (let i = index; i >= 0; i -= 1) {
    const char = src[i];
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth -= 1;
    }
  }

  if (open === -1) {
    return null;
  }

  depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const char = src[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return src.slice(open, i + 1);
      }
    }
  }

  return null;
}

/**
 * Whether a variable is optional in a deployed environment.
 *
 * `envsafe` distinguishes two kinds of fallback, and only one of them applies
 * in production:
 *
 *  - `default:` applies in every `NODE_ENV`, so the variable may legitimately
 *    be absent everywhere. `S3_BUCKET_NAME` and `S3_REGION` are these.
 *  - `devDefault:` applies only outside production. `next build` sets
 *    `NODE_ENV=production`, so a `devDefault` variable is **required** where it
 *    matters. `NEXTAUTH_SECRET` and `NEXT_PUBLIC_ENV` are these, and calling
 *    them optional would be wrong in the one environment that counts.
 *
 * The `default` test is case-sensitive and therefore does not also match
 * `devDefault`.
 *
 * @param {string} options the validator's options text
 * @returns {boolean}
 */
function isOptional(options) {
  return /(^|[^A-Za-z0-9_])default\s*:/.test(options);
}

/**
 * The environment contract, with each variable classified.
 *
 * `optional` means `envsafe` supplies a value when the variable is absent, so
 * a deployment that never sets it still works. That distinction used to be
 * invisible here - every `process.env.X` was reported as "required" - and
 * `--amplify` then demanded a strict grep pattern for a variable nobody had
 * set, which failed the production build (SCRUM-397/SCRUM-398).
 *
 * @returns {Map<string, {module: string, optional: boolean}>}
 */
function contractVars() {
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

    const matches = [
      ...src.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g),
    ].filter((match) => !NOT_DEVELOPER_SUPPLIED.has(match[1]));

    if (matches.length === 0) {
      fail(
        `${rel} reads no process.env.* variables, so the extractor is stale.`,
      );
    }

    for (const match of matches) {
      const name = match[1];
      if (found.has(name)) {
        continue;
      }

      const options = envsafeOptionsAt(src, match.index);
      if (options === null) {
        fail(
          `could not find the envsafe validator options around ` +
            `process.env.${name} in ${rel}, so it cannot be told whether the ` +
            `variable has a default. Refusing to guess: a defaulted variable ` +
            `reported as required is what broke the production build in ` +
            `SCRUM-397. Either restore the ` +
            `\`NAME: validator({ input: process.env.NAME, ... })\` shape or ` +
            `teach envsafeOptionsAt() the new one.`,
        );
      }

      found.set(name, { module: rel, optional: isOptional(options) });
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
 * Splits a classified contract into the two lists the checks below need.
 *
 * @param {Map<string, {module: string, optional: boolean}>} contract
 * @returns {{names: string[], required: string[], optional: string[]}}
 */
function partitionContract(contract) {
  const names = [...contract.keys()].sort();
  return {
    names,
    required: names.filter((name) => !contract.get(name).optional),
    optional: names.filter((name) => contract.get(name).optional),
  };
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

/**
 * Pulls the grep patterns out of a single build command.
 *
 * Handles the forms that could reasonably appear in a build spec: one or more
 * `-e PATTERN`, a `--regexp=PATTERN`, or a bare first argument. Quotes are
 * stripped. Flags are skipped so `grep -E -e FOO` reads as one pattern rather
 * than two.
 *
 * @param {string} command a build command that redirects into .env.production
 * @returns {{patterns: string[], error?: string}}
 */
function parseGrepPatterns(command) {
  const grepIndex = command.indexOf("grep");
  if (grepIndex === -1) {
    return {
      patterns: [],
      error: `writes to ${ENV_PRODUCTION_FILE} without calling grep`,
    };
  }

  // Everything between `grep` and the redirect. Splitting on `>` rather than
  // on `>>` so a single-redirect typo is still parsed and then reported by the
  // caller rather than silently yielding a pattern containing the filename.
  const afterGrep = command.slice(grepIndex + "grep".length);
  const redirect = afterGrep.indexOf(">");
  const argsText = (
    redirect === -1 ? afterGrep : afterGrep.slice(0, redirect)
  ).trim();

  if (argsText === "") {
    return { patterns: [], error: "grep is called with no pattern" };
  }

  const tokens = argsText.split(/\s+/);
  const patterns = [];
  let expectPattern = false;

  for (const token of tokens) {
    const unquoted = token.replace(/^['"]|['"]$/g, "");

    if (expectPattern) {
      patterns.push(unquoted);
      expectPattern = false;
      continue;
    }

    if (token === "-e" || token === "--regexp") {
      expectPattern = true;
      continue;
    }

    const inline = /^--regexp=(.*)$/.exec(token);
    if (inline) {
      patterns.push(inline[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }

    // Any other flag - `-E`, `-i`, `-v` - carries no pattern.
    if (token.startsWith("-")) {
      continue;
    }

    // A bare pattern, which grep accepts when no -e is given. Only the first
    // non-flag argument is a pattern; anything after it is a filename.
    if (patterns.length === 0) {
      patterns.push(unquoted);
    }
  }

  if (expectPattern) {
    return { patterns, error: "a -e flag is not followed by a pattern" };
  }

  if (patterns.length === 0) {
    return { patterns: [], error: "no grep pattern could be read" };
  }

  return { patterns };
}

/**
 * Whether a build command survives `grep` finding nothing.
 *
 * `grep` exits 1 when no line matches, and Amplify fails a build on any
 * non-zero exit, so a bare `env | grep -e X >> file` **stops the deploy** when
 * no variable matches `X`. A trailing `|| true` makes the absence a no-op
 * instead. That difference is the whole of SCRUM-397, so it is read here and
 * checked rather than left to whoever edits the spec next.
 *
 * Only the two idioms that plainly mean "ignore the failure" are recognised.
 * Anything else after the redirect is an error rather than a guess, for the
 * same reason `matchingPatterns` refuses to evaluate an arbitrary regex: a
 * confidently wrong answer about whether the deploy can fail here is worse
 * than no answer.
 *
 * @param {string} command one build command, trimmed
 * @returns {{tolerant: boolean, error?: string}}
 */
function commandTolerance(command) {
  const redirect = command.indexOf(">");
  if (redirect === -1) {
    return { tolerant: false };
  }

  // Past the redirect operator and its target filename.
  const afterTarget = command
    .slice(redirect)
    .replace(/^>+\s*\S+\s*/, "")
    .trim();

  if (afterTarget === "") {
    return { tolerant: false };
  }

  if (/^\|\|\s*(true|:)$/.test(afterTarget)) {
    return { tolerant: true };
  }

  return {
    tolerant: false,
    error:
      `cannot tell whether this command tolerates grep finding nothing ` +
      `("${afterTarget}"). Use a bare command or a trailing \`|| true\`, or ` +
      `teach commandTolerance() the new form`,
  };
}

/**
 * Every grep pattern amplify.yml uses to populate .env.production.
 *
 * Parsed out of the YAML text rather than through a YAML library, because this
 * script is deliberately dependency-free - `env-contract.yml` runs it with no
 * `yarn install` so it keeps reporting even when installation is broken.
 *
 * `entries` carries one record per command - its patterns and whether it
 * tolerates a no-match - which is what the tolerance rule in
 * checkAmplifySpec() needs. `patterns` and `commands` are the flat views the
 * coverage check and the tripwire already used, kept as they were.
 *
 * @param {string} spec the contents of amplify.yml
 * @returns {{patterns: string[], commands: number, errors: string[],
 *   entries: {line: number, patterns: string[], tolerant: boolean}[]}}
 */
function amplifyGrepPatterns(spec) {
  const patterns = [];
  const errors = [];
  const entries = [];
  let commands = 0;

  const lines = spec.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.includes(ENV_PRODUCTION_FILE)) {
      continue;
    }

    // Skip the file's own prose. Only a command in the build phase populates
    // anything, and every one of those redirects into the file.
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes(">")) {
      continue;
    }

    commands += 1;
    const { patterns: found, error } = parseGrepPatterns(trimmed);
    if (error) {
      errors.push(`amplify.yml:${index + 1} ${error}: ${trimmed}`);
    }
    patterns.push(...found);

    const { tolerant, error: toleranceError } = commandTolerance(trimmed);
    if (toleranceError) {
      errors.push(`amplify.yml:${index + 1} ${toleranceError}: ${trimmed}`);
    }
    entries.push({ line: index + 1, patterns: found, tolerant });
  }

  return { patterns, commands, errors, entries };
}

/**
 * Matches a variable name against the grep patterns.
 *
 * Patterns are required to be plain `[A-Za-z0-9_]+` - a literal name or name
 * prefix, which is what all of them are - and anything else is a hard failure
 * rather than a guess. grep takes a POSIX basic regular expression, JavaScript
 * takes a different dialect, and a check that quietly evaluates `\{2\}` or
 * `\(a\|b\)` under the wrong grammar would give a confidently wrong answer
 * about whether production has its environment. If a real regex is ever needed
 * in that build spec, this function is where to teach it one.
 *
 * Substring, not prefix: `grep -e ACCESS` matches `SECRET_ACCESS_KEY_AWS` in
 * the middle, and that is how three of the current variables are covered. The
 * same looseness is why a pattern can match a variable's *value* as well as
 * its name - see the note in amplify.yml.
 *
 * @param {string} name
 * @param {string[]} patterns
 * @returns {string[]} the patterns that match
 */
function matchingPatterns(name, patterns) {
  return patterns.filter((pattern) => {
    if (!/^[A-Za-z0-9_]+$/.test(pattern)) {
      fail(
        `amplify.yml uses the grep pattern "${pattern}", which is not a plain ` +
          `variable-name fragment. scripts/check-env-contract.js compares ` +
          `names against literal patterns only, so it cannot answer whether ` +
          `this one covers them. Teach matchingPatterns() the new form, or ` +
          `keep the patterns literal.`,
      );
    }
    return name.includes(pattern);
  });
}

/**
 * Which required variables reach the deployed runtime, and how.
 *
 * @param {string[]} names required variable names
 * @param {string[]} patterns grep patterns from amplify.yml
 * @param {Record<string, string>} [exemptions] name -> reason; injectable so a
 *   test can exercise the exemption path without mutating module state
 * @returns {{covered: Map<string, string[]>, exempt: Map<string, string>,
 *   uncovered: string[], unusedPatterns: string[]}}
 */
function amplifyCoverage(names, patterns, exemptions = AMPLIFY_EXEMPT) {
  const covered = new Map();
  const exempt = new Map();
  const uncovered = [];

  for (const name of names) {
    const matches = matchingPatterns(name, patterns);

    // A real grep pattern beats an exemption, so deleting a pattern shows up
    // as a change rather than being absorbed by the exemption list.
    if (matches.length) {
      covered.set(name, matches);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(exemptions, name)) {
      exempt.set(name, exemptions[name]);
      continue;
    }

    uncovered.push(name);
  }

  const unusedPatterns = patterns.filter(
    (pattern) => !names.some((name) => name.includes(pattern)),
  );

  return { covered, exempt, uncovered, unusedPatterns };
}

/**
 * The strictness rule, checked per command.
 *
 * A grep pattern's job is to copy values to the runtime, not to validate them:
 * console variables reach the build shell anyway, and `next build` imports the
 * envsafe modules, so a missing *required* variable already fails the build
 * with a message naming it. What strictness decides is what happens when a
 * pattern matches nothing at all.
 *
 *  - Covers at least one **required** variable -> must be strict. Matching
 *    nothing means that variable is absent, which should stop the deploy. A
 *    tolerant command here is the "silence a red build" reflex, and the one
 *    thing amplify.yml's header asks the reader not to do.
 *  - Covers **only optional** variables -> must be tolerant. They may
 *    legitimately be absent, and a strict command turns that into a failed
 *    deploy. This is the rule that would have caught SCRUM-397.
 *  - Covers **nothing in the contract** -> unconstrained. `NEXTAUTH_URL` is
 *    the standing case: NextAuth reads it directly rather than through
 *    envsafe, so it is absent from the derived list, and its strict grep is
 *    the only thing that would notice it disappearing from the console.
 *    Forcing either strictness on these would be a guess about a variable this
 *    script knows nothing about.
 *
 * @param {{line: number, patterns: string[], tolerant: boolean}[]} entries
 * @param {string[]} required required variable names
 * @param {string[]} optional optional variable names
 * @returns {string[]} human-readable problems, empty when the spec is right
 */
function strictnessIssues(entries, required, optional) {
  const issues = [];

  for (const entry of entries) {
    const hits = (names) =>
      names.filter((name) => matchingPatterns(name, entry.patterns).length);

    const requiredHit = hits(required);
    const optionalHit = hits(optional);
    const shown = entry.patterns.join(", ");

    if (requiredHit.length && entry.tolerant) {
      issues.push(
        `amplify.yml:${entry.line} pattern(s) ${shown} cover required ` +
          `variable(s) ${requiredHit.join(", ")}, so the command must not end ` +
          `in \`|| true\` - that would let the deploy continue with them ` +
          `missing. Remove the fallback.`,
      );
      continue;
    }

    if (!requiredHit.length && optionalHit.length && !entry.tolerant) {
      issues.push(
        `amplify.yml:${entry.line} pattern(s) ${shown} cover only optional ` +
          `variable(s) ${optionalHit.join(", ")}, which a deployment need ` +
          `never set. grep then exits 1, and Amplify fails the build - this ` +
          `is the SCRUM-397 outage. Append \`|| true\` to the command.`,
      );
    }
  }

  return issues;
}

/**
 * `--amplify`. Exits non-zero when a required variable would be absent from
 * the deployed environment.
 *
 * @param {Map<string, {module: string, optional: boolean}>} contract
 * @param {boolean} verbose
 */
function checkAmplifySpec(contract, verbose) {
  if (!fs.existsSync(AMPLIFY_SPEC)) {
    fail(
      "amplify.yml not found. It is the authoritative build spec for the " +
        "deployed app and is required by this check.",
    );
  }

  const spec = fs.readFileSync(AMPLIFY_SPEC, "utf8");
  const { patterns, commands, errors, entries } = amplifyGrepPatterns(spec);

  if (errors.length) {
    console.error(`✖ ${errors.length} malformed environment command(s):`);
    for (const error of errors) {
      console.error(`    ${error}`);
    }
    process.exit(1);
  }

  if (commands === 0) {
    fail(
      `amplify.yml has no command redirecting into ${ENV_PRODUCTION_FILE}. ` +
        `Either the build spec no longer populates the runtime environment ` +
        `that way - in which case this check needs revisiting rather than ` +
        `passing - or the parser here is stale.`,
    );
  }

  if (patterns.length < MIN_EXPECTED_AMPLIFY_PATTERNS) {
    fail(
      `only ${patterns.length} grep pattern(s) parsed from amplify.yml, ` +
        `expected at least ${MIN_EXPECTED_AMPLIFY_PATTERNS}. Refusing to run ` +
        `a check this weak.`,
    );
  }

  const { names, required, optional } = partitionContract(contract);
  const { covered, exempt, uncovered, unusedPatterns } = amplifyCoverage(
    names,
    patterns,
  );

  console.log(
    `${names.length} variable(s) in the contract from ` +
      `src/utils/env/{browser,server}.ts: ${required.length} required, ` +
      `${optional.length} optional`,
  );
  console.log(
    `${patterns.length} grep pattern(s) in amplify.yml across ${commands} command(s)`,
  );
  console.log(
    `${covered.size} carried into ${ENV_PRODUCTION_FILE}, ${exempt.size} exempt`,
  );

  if (verbose) {
    for (const [name, matches] of [...covered].sort()) {
      const label = contract.get(name).optional ? "  (optional)" : "";
      console.log(`    ${name}  <- ${matches.join(", ")}${label}`);
    }
    for (const [name, reason] of [...exempt].sort()) {
      console.log(`    ${name}  exempt: ${reason}`);
    }
  }

  if (unusedPatterns.length) {
    // Not a failure. `NEXTAUTH_URL` is the standing example: NextAuth reads it
    // straight from process.env rather than through envsafe, so it is
    // genuinely needed at runtime and genuinely absent from the derived list.
    // These are also the patterns strictnessIssues() leaves alone - it has no
    // basis to judge the strictness of a pattern whose variables it cannot see.
    console.log(
      `${unusedPatterns.length} pattern(s) match no contract variable` +
        (verbose ? `: ${unusedPatterns.join(", ")}` : " (run with --verbose)"),
    );
  }

  if (uncovered.length) {
    console.error(
      `\n✖ ${uncovered.length} contract variable(s) would be absent from the ` +
        `deployed environment:`,
    );
    for (const name of uncovered) {
      const entry = contract.get(name);
      // An optional variable still has to be covered. If a deployment does set
      // one and no pattern carries it, the build resolves the console value
      // and the runtime falls back to the code default - the SCRUM-385 split.
      const label = entry.optional
        ? ", optional: covered so a console override cannot be lost"
        : "";
      console.error(`    ${name}  (read by ${entry.module}${label})`);
    }
    console.error(
      `\nA variable set in the Amplify console reaches the build shell, but ` +
        `only reaches the *runtime* if amplify.yml copies it into ` +
        `${ENV_PRODUCTION_FILE}. One of two fixes:\n` +
        `  - add a grep pattern to amplify.yml covering it, or\n` +
        `  - add it to AMPLIFY_EXEMPT in this script with the reason it does ` +
        `not need to be there.\n` +
        `Leaving it out silently is what SCRUM-385 was filed for: a variable ` +
        `with a code default resolves one way at build time and another at ` +
        `runtime, and nothing errors.`,
    );
    process.exit(1);
  }

  const issues = strictnessIssues(entries, required, optional);
  if (issues.length) {
    console.error(
      `\n✖ ${issues.length} command(s) in amplify.yml have the wrong ` +
        `strictness:`,
    );
    for (const issue of issues) {
      console.error(`    ${issue}`);
    }
    console.error(
      `\nSee "Exit codes" in amplify.yml for the rule and why it exists.`,
    );
    process.exit(1);
  }

  console.log(
    `\n✓ amplify.yml carries every required variable into the deployed ` +
      `environment, and each command's strictness matches what it covers.`,
  );
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (arg) =>
      !["--check", "--verbose", "--list", "--github-env", "--amplify"].includes(
        arg,
      ),
  );
  if (unknown.length) {
    fail(`unknown argument(s): ${unknown.join(", ")}`);
  }

  const contract = contractVars();
  const { names, required, optional } = partitionContract(contract);
  const verbose = args.includes("--verbose");

  if (args.includes("--list")) {
    console.log(
      names
        .map((name) =>
          verbose && contract.get(name).optional ? `${name}  (optional)` : name,
        )
        .join("\n"),
    );
    return;
  }

  if (args.includes("--amplify")) {
    checkAmplifySpec(contract, verbose);
    return;
  }

  // Placeholders are emitted for optional variables too, deliberately.
  //
  // Not emitting them would make CI's `next build` exercise the code defaults,
  // which is what production actually runs - a tempting argument. But this
  // output is also `jest.setup.env.js`'s environment for all 80 suites, and
  // the defaults already have direct coverage in
  // `src/utils/env/s3Config.test.ts`, which asserts both the fallback and the
  // override. Changing the whole suite's environment to duplicate that is a
  // bad trade (SCRUM-398).
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
  const extra = [...declared].filter((name) => !contract.has(name)).sort();

  console.log(
    `${names.length} variable(s) in the contract from ` +
      `src/utils/env/{browser,server}.ts: ${required.length} required, ` +
      `${optional.length} optional`,
  );
  console.log(`${declared.size} variable(s) declared in .env.example`);

  if (extra.length) {
    // Not a failure: a variable may be read directly through process.env, or be
    // genuinely optional. Reviewing them for obsolescence is a human call.
    console.log(
      `${extra.length} declared variable(s) are not in the envsafe contract` +
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
      `\n✖ ${missing.length} contract variable(s) missing from .env.example:`,
    );
    for (const name of missing) {
      const entry = contract.get(name);
      const label = entry.optional ? ", optional" : "";
      console.error(`    ${name}  (read by ${entry.module}${label})`);
    }
    console.error(
      `\nAdd them to .env.example with a placeholder value so the team knows ` +
        `they exist. A required variable makes the application throw at ` +
        `import time without it; an optional one silently takes its code ` +
        `default, which is worth documenting rather than leaving to be ` +
        `discovered.`,
    );
    process.exit(1);
  }

  console.log("\n✓ .env.example documents every variable in the contract.");
}

// Only when run directly, so the parser above can be imported by
// scripts/check-env-contract.test.ts without the script executing.
if (require.main === module) {
  main();
}

module.exports = {
  amplifyCoverage,
  amplifyGrepPatterns,
  commandTolerance,
  envsafeOptionsAt,
  isOptional,
  matchingPatterns,
  parseGrepPatterns,
  strictnessIssues,
  AMPLIFY_EXEMPT,
  ENV_PRODUCTION_FILE,
  MIN_EXPECTED_AMPLIFY_PATTERNS,
};
