/**
 * The end-to-end layer: a real Chromium, against a real build, against a real
 * MySQL.
 *
 * `yarn test` is untouched by this file. Jest collects `*.test.ts(x)` and
 * `*.spec.ts(x)`; these are `*.e2e.ts`, which matches neither, and
 * `jest.shared.config.js` additionally ignores this whole directory. Two
 * independent reasons, because the dangerous failure here is not a browser
 * starting in the unit suite — that fails loudly — but Jest quietly collecting
 * a Playwright file and reporting the suite green with tests missing.
 *
 * ## What a green run proves, stated narrowly
 *
 * The journeys written here, at the viewports written here, and nothing else.
 * This is a smoke layer: it is not whole-app assurance and must not be
 * described as any. `docs/testing.md` lists the covered journeys.
 *
 * ## Decisions taken deliberately, with their reasoning
 *
 * **Screenshot comparison: no.** `toHaveScreenshot` is the only mechanism that
 * would catch a breakpoint converted in the wrong direction, which is a real
 * risk this repository carries. It is rejected anyway, because the maintenance
 * cost here is unusually high rather than merely normal: Tailwind v4 scans the
 * whole repository, so the compiled stylesheet changes when a *comment* names a
 * utility, and five UI systems coexist in the component tree. Snapshots under
 * those conditions change for reasons unrelated to the change under review, and
 * a suite whose failures are usually noise is a suite that gets its failures
 * waved through. Computed geometry is asserted instead — specific numbers, on
 * named elements, that fail for one reason.
 *
 * **Safe-area inset: a third run configuration, not a property of the mobile
 * one, and not yet built.** Chromium defines `env(safe-area-inset-bottom)` as
 * an actual `0px` when no override is set — fallback or no — so a device
 * descriptor cannot produce one and a 34px fallback is indistinguishable from
 * the real zero. The measurement is recorded at
 * `src/testing/layoutFixtures.ts:1753`. The only mechanism that works is the
 * CDP call `Emulation.setSafeAreaInsetsOverride` through
 * `context.newCDPSession(page)`, and it belongs on the one geometry assertion
 * that needs it rather than on every mobile journey. That assertion is the
 * mobile bottom navigation's measured height, which needs an onboarded user on
 * the map page and therefore needs Mapbox handled — so it is deferred with the
 * rest of that journey. **No project here sets an inset, and no test here
 * claims one.**
 *
 * **Mapbox, Pusher and SES: out of reach of these journeys, not stubbed.** The
 * honest statement is that the journeys in this skeleton never load the map,
 * never open a Pusher connection and never call an email procedure, so there is
 * nothing yet to stub. Route-level stubbing is the decided approach for when
 * they do — the env contract supplies a syntactically valid but non-functional
 * Mapbox token, so letting calls through is not an option that works — and it
 * is specified per journey in the tickets that add them. A stub written now
 * against no caller would be unexercised code that drifts.
 */

import { defineConfig } from "@playwright/test";
import {
  DESKTOP_VIEWPORT,
  E2E_BASE_URL,
  E2E_PORT,
  MOBILE_VIEWPORT,
  appServerEnv,
  e2eDatabaseTarget,
} from "./e2e/support/environment";

// Evaluated here, at config load, so that a missing or refused
// `TEST_DATABASE_URL` is reported by the guard's own message before a browser
// is downloaded or a build is started. The guard never includes the connection
// string in what it prints.
const databaseTarget = e2eDatabaseTarget();

export default defineConfig({
  testDir: "./e2e",

  /*
   * Narrower than Playwright's default `**\/*.@(spec|test).?(c|m)[jt]s?(x)`,
   * which would collide head-on with Jest's patterns. The extension is the
   * whole selector, exactly as `jest.config.js` splits its two projects by
   * one — a file cannot land in the wrong runner without also being named
   * wrongly.
   */
  testMatch: "**/*.e2e.ts",

  globalSetup: "./e2e/global-setup.ts",

  // Nothing here is order-dependent: every test seeds its own user. Full
  // parallelism is what keeps a browser suite's wall clock tolerable.
  fullyParallel: true,

  // A `test.only` left in a file passes locally and silently drops every other
  // test in it. On CI that is a failure rather than a convenience.
  forbidOnly: Boolean(process.env.CI),

  // One retry on CI, none locally. A browser test that fails once and passes on
  // retry is reported as flaky rather than green — the retry buys a signal, not
  // a pass. Locally a retry would hide the same signal from the person who can
  // act on it.
  retries: process.env.CI ? 1 : 0,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],

  use: {
    baseURL: E2E_BASE_URL,

    // Kept on the failing run only. A trace is the thing that makes a CI-only
    // failure diagnosable without reproducing it, and recording them for passes
    // would cost time and storage on every run for no signal.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "desktop",
      use: { browserName: "chromium", viewport: DESKTOP_VIEWPORT },
    },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: MOBILE_VIEWPORT,
        // `isMobile` sets the meta-viewport and `hasTouch` adds touch support.
        // Neither produces a safe-area inset — see the note at the top of this
        // file. They are set because a mobile viewport without touch is a
        // narrow desktop, and `useIsMobile` is not the only thing that differs.
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],

  webServer: {
    // The built app, not `next dev`: the production build is what ships, and
    // the two differ in ways an end-to-end test is exactly the wrong place to
    // be blind to. The build is part of the command rather than a separate
    // script so there is one definition of how the server comes up, and
    // `reuseExistingServer` below means a developer who already has one
    // running pays for neither.
    command: `yarn build && yarn next start --port ${E2E_PORT}`,
    url: E2E_BASE_URL,
    reuseExistingServer: !process.env.CI,
    // A cold `next build` is the dominant term and is well over Playwright's
    // 60s default. Five minutes is generous enough that a slow runner does not
    // fail spuriously and short enough to fail rather than hang.
    timeout: 5 * 60 * 1000,
    stdout: "pipe",
    stderr: "pipe",
    env: appServerEnv(databaseTarget),
  },
});
