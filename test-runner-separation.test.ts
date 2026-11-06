/**
 * The two test runners must not collect each other's files.
 *
 * Jest collects `*.test.ts(x)`, `*.spec.ts(x)` and `__tests__/**`; Playwright
 * collects `*.e2e.ts` under `e2e/`. Nothing enforces that by construction, and
 * the failure mode if it is ever broken is the quiet one: Jest loading a file
 * written against Playwright's `test` object throws at *load* time, which takes
 * the whole suite out of the run. `yarn test` then reports the suites that
 * remain as passing. Fewer tests, no failure — the same shape of accident the
 * superjson 2 bump produced, which dropped about 415 tests while printing
 * "Tests: 757 passed".
 *
 * So the separation is asserted rather than assumed, from inside `yarn test`,
 * where it costs nothing and needs no new CI job.
 *
 * This runs in the `node` project: it reads files and matches strings, and
 * touches no DOM.
 */

import { readFileSync, readdirSync } from "fs";
import path from "path";

const repoRoot = __dirname;
const e2eRoot = path.join(repoRoot, "e2e");

/**
 * Jest's own default patterns, as `jest.config.js` splits them. Written as
 * regular expressions rather than imported, because the configuration holds
 * them as glob strings and the question here is which *filenames* match.
 */
const JEST_COLLECTS = /(^|[./])(spec|test)\.[jt]sx?$|(^|\/)__tests__\//;

/** What Playwright's `testMatch` in `playwright.config.ts` collects. */
const PLAYWRIGHT_COLLECTS = /\.e2e\.ts$/;

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });

const relativeToRepo = (file: string) => path.relative(repoRoot, file);

describe("the Jest and Playwright suites are disjoint", () => {
  const e2eFiles = filesUnder(e2eRoot).map(relativeToRepo);

  /*
   * A membership assertion, not a count. A floor like `length > 0` would pass
   * on a directory that had lost every journey but one, and the whole point of
   * this file is that a silently shrinking suite is the thing to catch. Naming
   * the files means removing one is a deliberate edit here.
   */
  it("finds the end-to-end directory where it is expected", () => {
    expect(e2eFiles).toEqual(
      expect.arrayContaining([
        path.join("e2e", "global-setup.ts"),
        path.join("e2e", "smoke", "auth-redirect.e2e.ts"),
        path.join("e2e", "support", "environment.ts"),
        path.join("e2e", "support", "fixtures.ts"),
        path.join("e2e", "support", "session.ts"),
      ]),
    );
  });

  it("names every end-to-end test so that Jest cannot collect it", () => {
    const collectableByJest = e2eFiles.filter((file) =>
      JEST_COLLECTS.test(file),
    );

    expect(collectableByJest).toEqual([]);
  });

  it("names every end-to-end test so that Playwright does collect it", () => {
    // The complement of the rule above: a journey that Jest would ignore but
    // Playwright would also ignore is a test nothing runs, which is worse than
    // one in the wrong runner because nothing reports it at all. Support files
    // and the global setup are excluded by directory, not by name.
    const journeys = e2eFiles.filter(
      (file) =>
        !file.startsWith(path.join("e2e", "support") + path.sep) &&
        file !== path.join("e2e", "global-setup.ts"),
    );

    expect(journeys.length).toBeGreaterThan(0);
    expect(journeys.filter((file) => !PLAYWRIGHT_COLLECTS.test(file))).toEqual(
      [],
    );
  });

  /*
   * The filenames above are the first of two independent guards. This is the
   * second, and it is asserted as text because a Jest configuration cannot be
   * required here without pulling in its `process.env.TZ` side effect at an
   * unhelpful moment.
   */
  it.each(["jest.shared.config.js", "jest.integration.config.js"])(
    "keeps the e2e directory out of %s",
    (configFile) => {
      const contents = readFileSync(path.join(repoRoot, configFile), "utf8");

      expect(contents).toContain('"<rootDir>/e2e/"');
    },
  );
});
