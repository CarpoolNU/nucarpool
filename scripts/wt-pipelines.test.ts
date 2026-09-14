/**
 * One invariant, asserted across every `scripts/wt-*.sh`: **no pipeline
 * consumer may leave before its input is exhausted.**
 *
 * The locked-slot refusal in `wt-recycle.sh` exited 141 rather than 1 on CI,
 * because `git worktree list --porcelain | awk '...; exit'` left git killed by
 * SIGPIPE and `set -o pipefail` reports a signalled producer as the pipeline's
 * status (SCRUM-449). `wt-bootstrap.sh` and `wt-cleanup.sh` each carried the
 * same shape and were fixed under SCRUM-454; this file is the generalisation
 * that stops a fourth instance appearing in any of them.
 *
 * Reading from a shell variable is not the fix and this is not a style rule:
 * `printf` is a builtin, but bash takes SIGPIPE like any other producer. Nor
 * does it matter whether a given script sets `pipefail` itself - `wt-state.sh`
 * is sourced into two callers that do, so its pipelines run under theirs.
 *
 * It is asserted statically because the defect is a race. It needs the
 * producer still writing at the instant the consumer goes away, so a short
 * worktree table on a fast machine wins it by luck: the SCRUM-449 instance
 * passed every local run and failed on CI. The property holds of the source or
 * it does not hold at all, which is the only thing a test can pin down here.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Discovered rather than listed, so a fifth worktree script is covered the day
 * it lands instead of the day someone remembers this file.
 */
const scripts = fs
  .readdirSync(__dirname)
  .filter((entry) => /^wt-.*\.sh$/.test(entry))
  .sort();

/**
 * The script's source with whole-line comments removed, so prose describing
 * the very pipelines this forbids cannot fail the assertions below.
 */
const sourceOf = (script: string): string =>
  fs
    .readFileSync(path.join(__dirname, script), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * The awk programs in a script. Each is a single-quoted block with no quote
 * inside it - a shell constraint, not a convention - so it extracts cleanly.
 */
const awkProgramsIn = (code: string): string[] =>
  [...code.matchAll(/awk\b[^'\n]*'([^']*)'/g)].map((match) => match[1]);

describe("wt-*.sh pipeline consumers", () => {
  it("finds every worktree script", () => {
    expect(scripts).toEqual(
      expect.arrayContaining([
        "wt-bootstrap.sh",
        "wt-cleanup.sh",
        "wt-recycle.sh",
        "wt-state.sh",
      ]),
    );
  });

  it.each(scripts)("%s pipes into no consumer that exits early", (script) => {
    const code = sourceOf(script);

    // Consumers that are early-exiting by definition.
    expect(code).not.toMatch(/\|\s*head\b/);
    expect(code).not.toMatch(/\|\s*grep\s+[^|\n]*-[a-zA-Z]*[qm]\b/);

    // And awk programs, which exit early only when told to.
    expect(awkProgramsIn(code).filter((p) => /\bexit\b/.test(p))).toEqual([]);
  });

  /**
   * The awk assertion above is vacuously true for a script with no awk in it,
   * and would also pass if the extractor silently matched nothing. Asserting
   * across the set that it does find programs is what keeps it honest.
   */
  it("actually extracts awk programs", () => {
    const found = scripts.flatMap((script) => awkProgramsIn(sourceOf(script)));
    expect(found.length).toBeGreaterThan(0);
  });
});
