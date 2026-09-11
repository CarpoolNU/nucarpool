/*
 * Jest runs two projects, split by file extension:
 *
 *   node   - `*.test.ts`   pure logic, the tRPC routers, the ops scripts
 *   jsdom  - `*.test.tsx`  anything that renders or runs a hook
 *
 * The extension is the whole selector, so a file cannot land in the wrong
 * project without also being the wrong kind of file. Two projects rather than
 * jsdom everywhere: a jsdom environment is built per suite, and top-level jsdom
 * would also hide bugs, since server code accidentally reading `window` would
 * pass here and fail in production.
 *
 * **The `testMatch` patterns below are exactly Jest's own default pair split
 * down the `?(x)`.** That equality is deliberate and worth preserving on any
 * edit: the dangerous failure mode of this file is not a failing test but a
 * *missing* one, and a hand-written pattern narrower than the default drops
 * suites silently. `foo.spec.ts` and the bare `test.ts` form are collected for
 * that reason alone.
 *
 * `src/pages/` is off limits to test files of either extension, because a
 * filename there is also a route. See `docs/testing.md`.
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
      // `src/testing/staticImageStub.js`. This first surfaced in the first
      // component test to reach `UserCard`.
      //
      // Scoped to this project deliberately. Only components import images, so
      // a `.test.ts` in the node project reaching one is a mistake worth
      // failing loudly rather than papering over.
      //
      // `mixpanel-browser` likewise, for a different failure: `utils/mixpanel`
      // calls `init` at module scope, so any component that tracks an event
      // starts an analytics session merely by being imported - and `UserCard`
      // does, which covers most of the card and sidebar tree. That cost one
      // affected suite ~7.5s in queued events, `debug` logging and two
      // `indexedDB is not supported` errors. It made no network requests;
      // see the stub, which records how that was measured.
      //
      // The third-party module is stubbed rather than our own wrapper so that
      // `utils/mixpanel` loads for real and its exports cannot drift from a
      // hand-maintained fake.
      moduleNameMapper: {
        "\\.(png|jpe?g|gif|webp|avif|svg|ico)$":
          "<rootDir>/src/testing/staticImageStub.js",
        "^mixpanel-browser$": "<rootDir>/src/testing/mixpanelBrowserStub.js",
      },
    },
  ],
};
