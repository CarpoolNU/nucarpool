#!/usr/bin/env node
"use strict";

/**
 * Dependabot alert staleness check.
 *
 * Dependabot raises a pull request for an advisory it can fix by editing
 * `package.json`. It raises nothing for an advisory whose only fix is a
 * `yarn.lock` refresh of a transitive package, because npm security updates
 * only ever propose direct dependencies. There is no `.github/dependabot.yml`
 * option that changes that, and nothing else in this repository refreshes
 * transitive lockfile entries either - so such an alert opens, no pull request
 * appears, and it sits until somebody happens to look at the Security tab.
 * Three `brace-expansion` alerts sat that way for 25 days and were found by an
 * unrelated audit rather than by any process (SCRUM-696, SCRUM-698).
 *
 * This is the "somebody happens to look" step, done on a schedule. It does not
 * fix anything: it reads the alert list and fails when an alert has been open
 * long enough that no automated fix is coming. Deliberately broader than the
 * lockfile case that prompted it, because the same silence covers every other
 * reason an alert can stall - an advisory with no patched version yet, a
 * suppressed `ignore` entry, a failed pull request.
 *
 * Usage:
 *   node scripts/check-dependabot-alerts.js
 *   node scripts/check-dependabot-alerts.js --max-age-days 30
 *   node scripts/check-dependabot-alerts.js --alerts alerts.json
 *   node scripts/check-dependabot-alerts.js --json
 *
 * Exit codes follow the other `check-*` scripts: `0` clean, `1` findings,
 * `2` the check could not be run at all.
 */

const fs = require("fs");
const { execFileSync } = require("child_process");

/** `owner/repo`, as `gh api` wants it. */
const REPO = "CarpoolNU/nucarpool";

/**
 * How long an open alert may go unaddressed before it counts as stuck.
 *
 * Dependabot's npm schedule in `.github/dependabot.yml` is weekly, and
 * `cooldown.default-days` is 7. An alert that is going to be fixed
 * automatically is therefore fixed inside about ten days: one cooldown, then
 * the next weekly run. Fourteen days clears that with room to spare while
 * staying well short of the 25 days `brace-expansion` managed.
 *
 * It is a staleness threshold and not a service-level target. An alert younger
 * than this is reported as pending rather than ignored, so a run still shows
 * the whole open list.
 */
const DEFAULT_MAX_AGE_DAYS = 14;

/**
 * Alerts that are open on purpose.
 *
 * An alert can be open because nobody acted on it, or because somebody decided
 * not to - and an age check cannot tell those apart. Without a way to say "this
 * one is known", the first deliberate retention makes this check fail forever,
 * at which point it gets ignored and stops being a check at all.
 *
 * SCRUM-671 is the precedent: a `postcss` advisory reachable only through
 * `next`'s own nested copy, which no dependency bump could reach and which
 * needed a scoped `resolutions` entry instead. While that was being worked out
 * the alert was legitimately open.
 *
 * Keyed by GHSA identifier **and** package name, because one advisory can
 * produce an alert against several packages and a bare GHSA would quiet all of
 * them. An entry suppresses every alert for that pair, including ones that open
 * later.
 *
 * `reviewBy` is required and is not decoration: it is the date the retention
 * stops applying. Past it the alert goes back to being stuck, so a decision
 * made once cannot quietly become permanent. Extending one is a deliberate
 * edit here, with the reason updated.
 *
 * Empty, because nothing is currently retained. The shape is exercised by
 * `check-dependabot-alerts.test.ts` rather than by a placeholder entry.
 *
 * @type {{ghsaId: string, package: string, reason: string, reviewBy: string}[]}
 */
const RETAINED = [];

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(2);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days between two instants, rounded down.
 *
 * Calendar-insensitive on purpose. Age here is an elapsed-time question, not a
 * date-arithmetic one, so a day is 24 hours and a daylight-saving boundary
 * inside the window shifts an age by at most an hour - never by a day, because
 * the floor only moves if the elapsed time crosses a whole-day boundary.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {number}
 */
function ageInDays(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * The fields this check reads, pulled out of a raw alert.
 *
 * Narrowing here rather than passing raw alerts around keeps the report, the
 * tests and the issue body working from one shape, and keeps the API's much
 * larger payload out of everything downstream.
 *
 * @param {Record<string, any>} alert
 * @returns {Record<string, any>}
 */
function summarise(alert) {
  const advisory = alert.security_advisory || {};
  const vulnerability = alert.security_vulnerability || {};
  const dependency = alert.dependency || {};

  return {
    number: alert.number,
    state: alert.state,
    createdAt: alert.created_at,
    severity: advisory.severity || "unknown",
    ghsaId: advisory.ghsa_id || "unknown",
    summary: advisory.summary || "",
    package: (dependency.package && dependency.package.name) || "unknown",
    // "runtime" or "development". Null on alerts GitHub could not attribute to
    // a manifest section, which is why this is not defaulted to either one.
    scope: dependency.scope || "unknown",
    firstPatchedVersion:
      (vulnerability.first_patched_version &&
        vulnerability.first_patched_version.identifier) ||
      null,
    url: alert.html_url || null,
  };
}

/**
 * Sort findings worst-first, so a truncated read still shows the worst of it.
 *
 * Severity before age: a critical alert open for 15 days matters more than a
 * low one open for 200, and a report ordered by age alone buries it.
 */
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function bySeverityThenAge(a, b) {
  const rank = (s) => {
    const index = SEVERITY_ORDER.indexOf(s);
    // An unrecognised severity sorts last rather than first. A new severity
    // name should not silently become the top of every report.
    return index === -1 ? SEVERITY_ORDER.length : index;
  };
  return rank(a.severity) - rank(b.severity) || b.ageDays - a.ageDays;
}

/**
 * The decision this whole script exists to make: of the open alerts, which have
 * been open long enough that nothing is going to fix them on its own?
 *
 * Pure, and exported for the tests. Everything around it is fetching,
 * formatting and exit codes.
 *
 * @param {Record<string, any>[]} alerts raw alerts, as the API returns them
 * @param {{now: Date, maxAgeDays: number, retained?: typeof RETAINED}} options
 * @returns {{stuck: any[], pending: any[], retained: any[], open: number}}
 */
function triage(alerts, options) {
  const { now, maxAgeDays } = options;
  const retainedEntries = options.retained || RETAINED;

  // Only `open` counts. `fixed`, `dismissed` and `auto_dismissed` are all
  // settled states, and `auto_dismissed` in particular is GitHub closing a
  // low-impact development-scope alert by itself - re-raising those here would
  // reinstate noise the platform already decided to suppress.
  const open = alerts.filter((alert) => alert.state === "open").map(summarise);

  const stuck = [];
  const pending = [];
  const retained = [];

  for (const alert of open) {
    alert.ageDays = ageInDays(new Date(alert.createdAt), now);

    const entry = retainedEntries.find(
      (candidate) =>
        candidate.ghsaId === alert.ghsaId &&
        candidate.package === alert.package,
    );

    if (entry) {
      // An expired retention is worse than no retention: it is a decision
      // nobody has revisited. It rejoins `stuck` and says so, rather than
      // disappearing from the report.
      //
      // An unparseable `reviewBy` counts as expired. `new Date("31-12-2026")`
      // is an Invalid Date, every comparison against NaN is false, and reading
      // that as "not expired" would make a typo the one way to retain an alert
      // permanently - the exact outcome this date exists to prevent. A
      // mistyped date therefore fails loudly rather than quietly holding.
      const reviewBy = new Date(entry.reviewBy).getTime();
      const expired = Number.isNaN(reviewBy) || reviewBy <= now.getTime();
      if (!expired) {
        retained.push({
          ...alert,
          reason: entry.reason,
          reviewBy: entry.reviewBy,
        });
        continue;
      }
      stuck.push({ ...alert, expiredRetention: entry });
      continue;
    }

    if (alert.ageDays >= maxAgeDays) {
      stuck.push(alert);
    } else {
      pending.push(alert);
    }
  }

  return {
    stuck: stuck.sort(bySeverityThenAge),
    pending: pending.sort(bySeverityThenAge),
    retained: retained.sort(bySeverityThenAge),
    open: open.length,
  };
}

/**
 * Read every open alert through the `gh` CLI.
 *
 * `gh` rather than a `fetch` with a token: it is preinstalled on GitHub-hosted
 * runners and already authenticated for a local run, so one code path serves
 * both and no token handling lands in this file.
 *
 * `--paginate --slurp` returns an array of *pages*, not of records, so the
 * result is flattened one level. Paginating rather than taking a single
 * `per_page=100` page on purpose: a truncated list would make this check pass
 * by reading less, which is the one failure mode it must not have.
 *
 * @returns {Record<string, any>[]}
 */
function fetchAlerts() {
  let raw;
  try {
    raw = execFileSync(
      "gh",
      [
        "api",
        `repos/${REPO}/dependabot/alerts?state=open&per_page=100`,
        "--paginate",
        "--slurp",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    const stderr = (error.stderr || "").toString().trim();
    fail(
      "could not read the Dependabot alert list through `gh api`.\n" +
        `  ${stderr || error.message}\n\n` +
        "  Reading this endpoint needs Dependabot alerts read access. In CI\n" +
        "  that is `security-events: read` on the job; locally it is a `gh\n" +
        "  auth login` with the `security_events` scope. Pass --alerts <file>\n" +
        "  to check a list fetched some other way.",
    );
  }

  const pages = JSON.parse(raw);
  if (!Array.isArray(pages)) {
    fail("`gh api --slurp` returned something that is not an array");
  }
  // Defensive about the slurp shape rather than assuming it: a single-page
  // response from a future `gh` could arrive unwrapped, and flattening only
  // what is actually an array handles both without guessing.
  return pages.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

/**
 * @param {string} file
 * @returns {Record<string, any>[]}
 */
function readAlertsFile(file) {
  if (!fs.existsSync(file)) {
    fail(`--alerts file not found: ${file}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`--alerts file is not valid JSON: ${error.message}`);
  }

  // Accepts either a flat array of alerts or the array-of-pages `gh api
  // --paginate --slurp` writes, so the file can be produced by the same
  // command this script would have run.
  if (!Array.isArray(parsed)) {
    fail("--alerts file must contain a JSON array");
  }
  return parsed.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
}

/**
 * One line per alert, in the order `triage` sorted them.
 *
 * @param {any} alert
 * @returns {string}
 */
function describe(alert) {
  const patched = alert.firstPatchedVersion
    ? `patched in ${alert.firstPatchedVersion}`
    : "no patched version yet";
  return (
    `    #${alert.number} ${alert.severity} ${alert.package} ` +
    `(${alert.scope}, ${alert.ageDays}d open, ${patched}) ${alert.ghsaId}`
  );
}

/**
 * The human report, entirely on stdout - including the findings.
 *
 * The sibling `check-*` scripts send their findings to stderr so CI highlights
 * them. This one does not, and the reason is that its output is *captured*:
 * `dependabot-alerts.yml` pipes it into the body of a tracking issue. Node's
 * stdout and stderr are independent asynchronous streams when either is a pipe,
 * so a report split across both and recombined with `2>&1` can arrive with its
 * lines interleaved out of order. One stream is the only way to guarantee a
 * readable report, and the workflow emits its own `::error::` annotation for
 * the highlighting this gives up.
 */
function report(result, maxAgeDays) {
  console.log(`${result.open} open Dependabot alert(s)`);

  if (result.retained.length) {
    console.log(`\n${result.retained.length} retained on purpose:`);
    for (const alert of result.retained) {
      console.log(describe(alert));
      console.log(`        ${alert.reason} (review by ${alert.reviewBy})`);
    }
  }

  if (result.pending.length) {
    console.log(
      `\n${result.pending.length} open less than ${maxAgeDays} days, ` +
        "still within the window an automated fix would arrive in:",
    );
    for (const alert of result.pending) {
      console.log(describe(alert));
    }
  }

  if (!result.stuck.length) {
    console.log(`\n✔ no alert has been open ${maxAgeDays} days or more`);
    return;
  }

  console.log(
    `\n✖ ${result.stuck.length} alert(s) have been open ${maxAgeDays} days ` +
      "or more, so no automated fix is coming:",
  );
  for (const alert of result.stuck) {
    console.log(describe(alert));
    if (alert.expiredRetention) {
      console.log(
        `        retention expired ${alert.expiredRetention.reviewBy}: ` +
          `${alert.expiredRetention.reason}`,
      );
    }
    if (alert.url) {
      console.log(`        ${alert.url}`);
    }
  }
  console.log(
    "\nEach one needs a decision. A transitive advisory is cleared by deleting\n" +
      "its `yarn.lock` entries and re-running `yarn install` - `yarn upgrade\n" +
      "<name>` does nothing for a package that is not in `package.json`. One\n" +
      "reachable only through a dependency's own nested copy needs a scoped\n" +
      "`resolutions` entry instead (SCRUM-671). One that is open deliberately\n" +
      "belongs in `RETAINED` in this file, with a reason and a review date.",
  );
}

function parseArgs(argv) {
  const options = {
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
    alertsFile: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--max-age-days") {
      const value = Number(argv[(i += 1)]);
      if (!Number.isInteger(value) || value < 0) {
        fail("--max-age-days needs a non-negative whole number of days");
      }
      options.maxAgeDays = value;
    } else if (arg === "--alerts") {
      options.alertsFile = argv[(i += 1)];
      if (!options.alertsFile) {
        fail("--alerts needs a file path");
      }
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const alerts = options.alertsFile
    ? readAlertsFile(options.alertsFile)
    : fetchAlerts();

  const result = triage(alerts, {
    now: new Date(),
    maxAgeDays: options.maxAgeDays,
  });

  if (options.json) {
    // Written to stdout as a single line so a workflow can capture it without
    // interleaving with the human report, which goes to stderr for findings
    // and stdout otherwise. `--json` suppresses the prose entirely for that
    // reason.
    console.log(JSON.stringify({ maxAgeDays: options.maxAgeDays, ...result }));
  } else {
    report(result, options.maxAgeDays);
  }

  process.exit(result.stuck.length ? 1 : 0);
}

// Only when run directly, so `triage` can be imported by
// scripts/check-dependabot-alerts.test.ts without the script executing - the
// same pattern as scripts/check-page-routes.js.
if (require.main === module) {
  main();
}

module.exports = {
  triage,
  summarise,
  ageInDays,
  bySeverityThenAge,
  DEFAULT_MAX_AGE_DAYS,
  RETAINED,
  REPO,
};
