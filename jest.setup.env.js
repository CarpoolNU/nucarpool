"use strict";

/**
 * Test environment bootstrap (SCRUM-211).
 *
 * `src/utils/env/{browser,server}.ts` validate with envsafe at import time, so any
 * suite that reaches `serverEnv` — directly, or transitively through `appRouter` —
 * throws on import unless every required variable is set.
 *
 * The required names and their throwaway values come from
 * `scripts/check-env-contract.js --github-env`, the same source `build.yml` uses to
 * satisfy envsafe in CI. Reusing it means the test suite cannot drift from the
 * environment contract: a variable added to the env modules is picked up here with
 * no change to this file.
 *
 * Real values already present in the environment are never overwritten, so running
 * the suite with a populated `.env` behaves the same as running it in CI.
 */

const { execFileSync } = require("child_process");
const path = require("path");

const CONTRACT_SCRIPT = path.join(
  __dirname,
  "scripts",
  "check-env-contract.js",
);

const output = execFileSync(
  process.execPath,
  [CONTRACT_SCRIPT, "--github-env"],
  {
    encoding: "utf8",
  },
);

for (const line of output.split("\n")) {
  const separator = line.indexOf("=");
  if (separator === -1) {
    continue;
  }

  const name = line.slice(0, separator);
  if (!process.env[name]) {
    process.env[name] = line.slice(separator + 1);
  }
}
