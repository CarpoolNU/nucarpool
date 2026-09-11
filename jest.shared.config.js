/*
 * Everything the three Jest configurations have in common.
 *
 * This file exists because `jest.config.js` now declares `projects`, and a
 * `projects` config ignores most per-suite options set beside it - `transform`,
 * `setupFiles` and `testEnvironment` all have to live *inside* each project.
 * `jest.integration.config.js` used to obtain those by spreading
 * `require("./jest.config")`, which would now spread a `projects` array instead
 * and silently collect nothing. Both of them read this file instead, so there is
 * exactly one definition of how a module is compiled and how the environment is
 * populated, and no configuration inherits another's project list.
 *
 * `rootDir` is set explicitly rather than left to Jest's default. Inside a
 * `projects` entry the default is the *project's* directory, so a `<rootDir>`
 * token in `setupFiles` would resolve differently depending on which config
 * loaded this object. Pinning it to the repository root makes every path below
 * mean the same thing everywhere.
 */

/*
 * Every test run reads the same clock.
 *
 * Without this, `Date`'s local accessors and constructors resolve against
 * whatever zone the machine is in - UTC on Amplify and GitHub Actions,
 * `America/New_York` on a developer's laptop - so a timezone-sensitive test
 * could pass in one place and fail in the other, or worse pass in both while
 * asserting different things. `minutesApart` in `src/utils/recommendation.ts`
 * was exactly that: the defect it now guards against was invisible locally and
 * live in production.
 *
 * Set here rather than in `setupFiles`, and rather than from inside a test,
 * because **assigning `process.env.TZ` once the worker is running has no
 * effect**: V8 caches the zone per isolate and Jest's worker does not
 * invalidate it, so a loop over zones inside a test silently reads the first
 * one for all of them. It has to be in the parent process, before the workers
 * are forked, which is what this is - and it happens as a side effect of
 * *requiring* this file, so every configuration that reads it is pinned.
 *
 * `NUCARPOOL_TEST_TZ` is the deliberate escape hatch, and the only way to
 * exercise a second zone for real - `test.yml` uses it to run the suite twice.
 * The default is UTC, matching how schedule times are stored and how CI runs.
 */
process.env.TZ = process.env.NUCARPOOL_TEST_TZ || "UTC";

module.exports = {
  rootDir: __dirname,

  /**
   * Replaces the `ts-jest` preset so that `node_modules` is transformed too.
   *
   * The preset's own `transform` covers `^.+\.tsx?$` only, and Jest excludes
   * `node_modules` from transformation by default. An ESM-only dependency
   * therefore reaches `jest-runtime` as raw `import` syntax and throws
   * "Cannot use import statement outside a module" - which fails the whole
   * *suite* at load time rather than failing an assertion, so every test in it
   * stops running. On the superjson 2 bump that removed about 415 tests from the
   * run, including every tRPC authorization suite, while `Tests: 757 passed`
   * appeared in the summary with no failures listed.
   *
   * Node is not the problem: Node 22 supports `require()` of an ES module, so
   * `ts-node`, the seed script and `next build` all load these packages fine.
   * Jest is the exception because it resolves modules through its own registry.
   *
   * `transformIgnorePatterns: []` transforms **all** of `node_modules` rather
   * than an allow-list of known ESM-only packages. That is the point: an
   * allow-list has to be edited every time a dependency goes ESM-only, and
   * forgetting looks exactly like the bug above - tests quietly not running.
   * Transforming everything cannot be forgotten. It costs about three seconds
   * on a cold Jest cache and nothing on a warm one; a package that TypeScript
   * cannot parse would fail loudly, which is the failure mode we want.
   *
   * The extension pattern covers `.mjs` deliberately - an ESM-only package may
   * publish its entry point as `.mjs`, and missing it reproduces the original
   * error. `.cjs` is already CommonJS and passes through harmlessly.
   */
  transform: {
    "^.+\\.[cm]?[tj]sx?$": [
      "ts-jest",
      {
        // `allowJs` so plain JavaScript in `node_modules` is compiled at all;
        // `module: commonjs` is what actually rewrites `import` to `require`.
        //
        // `jsx` has to be overridden as well. `tsconfig.json` sets
        // `"jsx": "preserve"` because Next does its own JSX transform, and
        // ts-jest merges this object *over* that file rather than replacing
        // it - so without this line a `.test.tsx` file is handed to
        // `jest-runtime` with its JSX still in it and dies on the first `<`.
        // `react-jsx` is the automatic runtime, which needs no `import React`
        // in every test file.
        tsconfig: {
          allowJs: true,
          module: "commonjs",
          esModuleInterop: true,
          jsx: "react-jsx",
        },
      },
    ],
  },
  transformIgnorePatterns: [],

  // The paths to modules that run some code to configure or set up the testing
  // environment before each test. `jest.setup.env.js` populates the envsafe
  // placeholders; every project needs it, because `serverEnv` is reachable
  // transitively from almost anything.
  setupFiles: ["<rootDir>/jest.setup.env.js"],

  // An array of regexp pattern strings that are matched against all test paths,
  // matched tests are skipped.
  //
  // "/\\.next/" is not part of Jest's default and must stay. Next
  // compiles anything under src/pages/ into .next/server/pages/, and a compiled
  // bundle still contains the `describe`/`it` calls of any test that got swept
  // in. Without this, `yarn test` after a local `yarn build` fails on a build
  // artifact rather than on source - a confusing failure that CI never sees,
  // because every CI job starts from a clean checkout.
  //
  // "\\.db\\.test\\.ts$" keeps the database-backed suite out of the default one.
  // Those files need a real MySQL, so collecting them there would
  // make `yarn test` fail without Docker - and that suite's whole value is
  // that it does not need any. They run through `yarn test:db`, whose
  // `jest.integration.config.js` overrides this list precisely because
  // spreading it would make the integration config ignore its own tests.
  testPathIgnorePatterns: ["/node_modules/", "/\\.next/", "\\.db\\.test\\.ts$"],
};
