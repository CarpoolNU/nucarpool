/*
 * Jest configuration for the database-backed suite.
 *
 * A separate configuration rather than a third entry in `jest.config.js`'s
 * `projects` array, so that `yarn test` stays exactly what it was: fast,
 * mock-only, and runnable with no database and no Docker. This one is opt-in
 * through `yarn test:db`, and it is the only one that can reach a database.
 *
 * The split is by filename. A database-backed test is `*.db.test.ts`, sits
 * next to the module it covers like every other test here, and is excluded
 * from the default suite by a pattern in `jest.shared.config.js`. Reusing the
 * `.test.ts` suffix and separating by directory was the alternative; the
 * suffix wins because `yarn test` picks up test files by pattern from the
 * whole repository, so a directory would have had to be excluded by path in
 * one config and included by path in the other - two places to get wrong
 * instead of one.
 *
 * Everything about how modules are compiled and how the environment is
 * populated is inherited from `jest.shared.config.js`, deliberately:
 * `transform`, `transformIgnorePatterns: []` (without which an ESM-only
 * dependency stops a whole suite from loading), `setupFiles` for the envsafe
 * placeholders, and the `process.env.TZ` pinning that file performs when it is
 * required. That last one matters more here than in the mocked suite -
 * `carpool_search` stores `@db.Time(0)` and `@db.Date` columns, and asserting
 * on a value that has been through MySQL and back is only reproducible if the
 * zone is fixed.
 *
 * **Read the shared file, not `jest.config.js`.** It used to be the latter,
 * which stopped being safe the moment `jest.config.js` grew a `projects` array:
 * spreading that here would import a project list *and* leave the
 * `testMatch` below inert, because Jest ignores a top-level `testMatch` when
 * `projects` is present. The result is a run that collects nothing and exits
 * "no tests found" rather than failing - the same silent-removal failure mode
 * SCRUM-324 was filed for. There is no jsdom in this configuration and there
 * should not be: this suite is database-only and contains no React.
 */

const sharedConfig = require("./jest.shared.config");

module.exports = {
  ...sharedConfig,

  displayName: "integration",

  // Inherited from `jest.config.js` before this file read the shared config
  // instead; restated so `yarn test:db --coverage` still uses the same
  // provider as `yarn test --coverage`. Inert without the flag.
  coverageProvider: "v8",

  // Only the database-backed files. `jest.config.js`'s projects use Jest's own
  // default patterns, which would also collect these.
  testMatch: ["**/*.db.test.ts"],

  /*
   * Overridden, not extended, and this is the trap worth naming.
   *
   * `jest.shared.config.js` ignores `\.db\.test\.ts$` so the fast suite skips
   * these files. Spreading it above copies that pattern in - which would
   * make this configuration ignore the only files it exists to run, and Jest
   * would exit "no tests found" rather than fail, so nothing would look wrong.
   * The two entries below are the shared config's other two, kept for the same
   * reasons it states.
   */
  testPathIgnorePatterns: ["/node_modules/", "/\\.next/"],

  // Approves the target, builds the schema from migration history, and proves
  // the database is reachable - once, in the parent process, before any worker
  // starts. A refused or unreachable target is then one clear message instead
  // of the same failure repeated per suite.
  globalSetup: "<rootDir>/jest.integration.globalSetup.js",

  // Truncation between tests. Registered here rather than left to each suite
  // so isolation cannot be forgotten in a new file.
  setupFilesAfterEnv: ["<rootDir>/jest.integration.setupAfterEnv.js"],

  /*
   * One worker, because there is one database.
   *
   * Truncating between tests is global to the schema, so two workers would
   * empty the database from under each other and the failures would look like
   * flaky assertions rather than a configuration problem. Set here rather than
   * passed as `--runInBand` on the command line so it cannot be dropped by
   * whoever runs it.
   *
   * The way out, when the suite is large enough to need it, is a database per
   * worker keyed on `JEST_WORKER_ID` - not more workers on one database.
   */
  maxWorkers: 1,

  // A first connection to a cold container, plus `prisma migrate deploy`
  // having just run, is slower than anything in the mocked suite. Prisma's own
  // interactive-transaction timeout (5s) sits well inside this, so a hung
  // transaction still fails as itself.
  testTimeout: 30000,
};
