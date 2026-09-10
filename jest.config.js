/*
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 *
 * ---------------------------------------------------------------------------
 * `yarn test` runs two projects, split by file extension:
 *
 *   node   - `*.test.ts`   every existing suite: pure logic, the tRPC routers,
 *                          the ops scripts. No DOM, and none needed.
 *   jsdom  - `*.test.tsx`  components and hooks (SCRUM-377). Anything that
 *                          renders or runs an effect.
 *
 * Two projects rather than switching the whole suite to jsdom. The node
 * project runs 1684 tests in about 3.4 seconds; a jsdom environment is
 * constructed per suite and would slow all 67 of them down for no benefit,
 * since not one of them touches a DOM. The extension is the whole selector -
 * there is no directory to remember and no list to keep in sync, and a file
 * cannot end up in the wrong project without also being the wrong kind of
 * file.
 *
 * Why this arrangement, and not the obvious ones:
 *
 *   - `testEnvironment: "jsdom"` at the top level. Slower for every suite, and
 *     it also hides real bugs: server code that accidentally reads `window`
 *     would pass here and fail in production.
 *   - A `@jest-environment jsdom` docblock per component test. Works, but the
 *     enforcement is a comment - forget it and the suite fails with
 *     `document is not defined`, which reads like a broken test rather than a
 *     missing pragma.
 *   - `testEnvironmentOptions` / a custom environment. Nothing here needs one.
 *
 * The `testMatch` patterns below are, together, exactly Jest's own default
 * pair split down the `?(x)` - `**\/__tests__\/**\/*.[jt]s?(x)` and
 * `**\/?(*.)+(spec|test).[tj]s?(x)` - with the `x` forms routed to jsdom and
 * the rest to node. That equality is the point and is worth preserving on any
 * edit: SCRUM-324 established that the dangerous failure mode of this file is
 * not a failing test but a *missing* one, and a hand-written pattern narrower
 * than the default drops suites silently. `foo.spec.ts` and the bare `test.ts`
 * form are collected here for that reason alone; the repository writes neither
 * today.
 *
 * `src/pages/` remains off limits to test files of *either* extension, and for
 * `.tsx` the risk is if anything higher - `pageExtensions` lists `tsx` first,
 * so `index.test.tsx` beside a page is the route `/index.test`.
 * `scripts/check-page-routes.js` matches on `(^|\.)(test|spec)\.` and covers
 * both. A component test for a page imports it from outside the directory;
 * `src/server/pusherAuthEndpoint.test.ts` is the pattern.
 * ---------------------------------------------------------------------------
 */

/*
 * Requiring this pins `process.env.TZ` in the parent process, before Jest
 * forks a worker. It has to happen here rather than in a project, for the
 * reason that file explains at length.
 */
const sharedConfig = require("./jest.shared.config");

module.exports = {
  // Indicates which provider should be used to instrument code for coverage.
  // A root-level option: `projects` entries do not carry their own.
  coverageProvider: "v8",

  projects: [
    {
      ...sharedConfig,
      displayName: "node",

      // Jest's default, which is also `jest-environment-node`. Named rather
      // than left implicit so that the contrast with the project below is
      // visible in one place.
      testEnvironment: "node",

      testMatch: ["**/__tests__/**/*.[jt]s", "**/?(*.)+(spec|test).[jt]s"],
    },
    {
      ...sharedConfig,
      displayName: "jsdom",
      testEnvironment: "jsdom",

      testMatch: ["**/__tests__/**/*.[jt]sx", "**/?(*.)+(spec|test).[jt]sx"],

      // `setupFiles` (inherited above) runs before the test framework is
      // installed, so `expect` does not exist yet and jest-dom cannot register
      // its matchers there. This is the after-env hook, and it is scoped to
      // this project: the node suites have no DOM for `toBeInTheDocument` to
      // talk about.
      setupFilesAfterEnv: ["<rootDir>/jest.setup.dom.ts"],

      // Static image imports resolve to a stub instead of being handed to
      // `ts-jest`, which cannot parse a PNG and throws at *load* time - taking
      // the whole suite out of the run rather than failing it. See
      // `src/testing/staticImageStub.js`; SCRUM-414 hit this on the first
      // component test to reach `UserCard`.
      //
      // Scoped to this project deliberately. Only components import images, so
      // a `.test.ts` in the node project reaching one is a mistake worth
      // failing loudly rather than papering over.
      moduleNameMapper: {
        "\\.(png|jpe?g|gif|webp|avif|svg|ico)$":
          "<rootDir>/src/testing/staticImageStub.js",
      },
    },
  ],
};
