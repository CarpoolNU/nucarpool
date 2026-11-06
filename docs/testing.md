# Testing

```bash
yarn test                          # everything; no database, no Docker
yarn test path/to/file.test.ts     # one file
yarn test:db                       # opt-in, needs a real MySQL — see below
```

## Two Jest projects, split by file extension

| Project | Collects     | Environment | For                                   |
| ------- | ------------ | ----------- | ------------------------------------- |
| `node`  | `*.test.ts`  | node        | Pure logic, tRPC routers, ops scripts |
| `jsdom` | `*.test.tsx` | jsdom       | Anything that renders or runs a hook  |

`yarn test` runs both and reports one result. The extension is the whole selector, so a file cannot land in the wrong project without also being the wrong kind of file. Shared compiler settings live in [`jest.shared.config.js`](../jest.shared.config.js).

Two configuration details are load-bearing:

- **`node_modules` is transformed**, which is why the config is written out rather than using the `ts-jest` preset. Without it an ESM-only dependency makes a whole suite fail to _load_ — which silently removes its tests from the run instead of failing them.
- **`jest.integration.config.js` reads `jest.shared.config.js`, not `jest.config.js`.** Requiring the latter would pull in its `projects` array and collect nothing.

## Never put a test file under `src/pages/`

Next's `pageExtensions` includes `.ts` and `.tsx`, so a filename there is also a URL: `admin.test.tsx` ships as the route `/admin.test`. `yarn check:routes` fails the build if one appears.

Test a route or page by importing it from outside the directory. [`src/server/pusherAuthEndpoint.test.ts`](../src/server/pusherAuthEndpoint.test.ts) is the pattern — it sits beside the other half of the feature and says why in its header.

## Timezones

`jest.shared.config.js` pins `process.env.TZ` to **UTC** by default, in the parent process before workers fork. It has to happen there: assigning `process.env.TZ` once a worker is running has no effect, because V8 caches the zone per isolate.

**`NUCARPOOL_TEST_TZ` is the only way to exercise a second zone.** Setting `TZ` directly is overwritten and does nothing.

```bash
NUCARPOOL_TEST_TZ=America/New_York yarn test
```

CI runs the suite twice — once in UTC, once in `America/New_York` — so a plain local `yarn test` only covers the first.

## What a green run does and does not prove

Everything `yarn test` runs is on mocks. **A passing run says nothing about real database queries**, and coverage of the React layer is thin, so a frontend change is mostly unguarded.

Coverage is genuinely broad on pure logic and on the tRPC routers' authorization and ownership checks, plus the ops scripts' planning halves.

### jsdom does no layout and evaluates no CSS

Read the header of [`src/testing/viewport.ts`](../src/testing/viewport.ts) before trusting a green run on anything mobile. Measured in this jsdom:

- every element measures zero, whatever its declared size;
- media queries and `desktop:` utilities are inert, and `window.matchMedia` is **absent**, not stubbed;
- `100dvh` never resolves, and jsdom's parser actively mangles `env(safe-area-inset-bottom)`;
- `z-index` is not computed, so "this covers that" is not observable.

So a jsdom test can assert that a control is **in the tree** and what happens when it is activated — not geometry.

`getComputedStyle` is the trap. For an **inline** style it echoes the declared string back uncomputed, which looks like a measurement and is not one. It _does_ resolve a stylesheet styled-components injects, which is a real capability and the basis of the colour assertions in `EntryLabel.test.tsx`.

### Rendering at a mobile viewport

Use the helpers in `src/testing/viewport.ts` — `setViewportWidth`, `resizeViewportTo`, `MOBILE_WIDTH`, `DESKTOP_WIDTH`, `restoreViewportAfterEach`. jsdom reports a fixed `innerWidth` and never changes it, so the viewport has to be written with `Object.defineProperty`. `MOBILE_WIDTH` and `DESKTOP_WIDTH` straddle the breakpoint by one pixel, so an off-by-one fails a test rather than passing one.

### Measuring layout in a real browser

jsdom cannot do the layout half at all, so there is a harness for doing it in Chromium by hand: [`scripts/measure-layout.ts`](../scripts/measure-layout.ts), with [`src/testing/layoutProbe.js`](../src/testing/layoutProbe.js) running in the page and [`src/testing/layoutFixtures.ts`](../src/testing/layoutFixtures.ts) holding what gets measured.

```bash
npx ts-node scripts/measure-layout.ts                            # list fixtures
npx ts-node scripts/measure-layout.ts group-member-card-trigger  # serve one
```

It compiles `src/styles/globals.css` through `@tailwindcss/postcss` — the same plugin, entry point, `@config` and repo-wide scan the build uses — mounts a fixture inside `#__next`, and serves both over HTTP on an OS-assigned port. Then you drive a browser to it, resize, and evaluate the probe call the banner prints. About 200ms of compile, no `.env`, no `.next`.

**What it proves.** That this project's real CSS, at a given viewport width, gives a reproduction of a component's markup the box you think it does — `rect`, `clientHeight` and `contentWidth` separately, plus a 3×3 hit-test grid over a control's footprint and each neighbour's share of it.

**What it does not prove**, and the third one is the one that matters:

1. It measures a **copy** of the markup, not the component. `reproduces` on each fixture names the class strings it copied and the file they came from, and `scripts/measure-layout.test.ts` fails in `yarn test` the moment one is no longer there — but a guarded copy is still a copy, and only the class strings are guarded, not the container chain above them. The printed predicted `contentWidth` is the check on that chain: if the browser disagrees, the fixture is wrong and every figure under it is wrong too.
2. It says nothing about a real device — no touch, no safe-area inset, no browser chrome moving under `dvh`.
3. **Nothing runs it.** It is not in `yarn test`, not in CI, not scheduled. A criterion measured through it is measured once, by someone who chose to. The class-name assertions the mobile tickets left behind are still the only standing guard, and they are proxies. Making these durable means a browser in CI, which means a new dev dependency — deliberately not done yet.

Four edges are paid for and encoded rather than left to be rediscovered:

- **Probe a grid, never a centre point.** `gridPoints` has no single-point option — a past measurement of one control's centre recorded it as safe, missing a hazard in its left third.
- **Every `elementFromPoint` is viewport-guarded, structurally.** That call returns `null` both for "nothing is there" and for "outside the viewport", so an off-screen probe reads as the reassuring answer. `plannedProbePoints` removes off-screen points before the DOM is asked, and reports `measurable: false` when it removed all of them — which is a different result from "probed and found nothing".
- **A height criterion reads `clientHeight`, not the rect.** Tailwind v4 compiles `divide-y` to `:where(.divide-y > :not(:last-child)) { border-bottom-width: 1px }`, so every row **but the last** carries a border pixel — the opposite end of the list from v3's `& > * + *`. The group-card fixture holds a bordered and an unbordered row so the 73-versus-72 difference is observable rather than asserted.
- **One stylesheet is only sound when every utility both variants need is still emitted.** Reverting `p-3` to `px-3 py-2` needs no second build, because both are in use elsewhere in the repo; a change to a scan _input_ needs two. And remember the scan reaches this whole repository, comments included: naming a utility in a test comment ships it as CSS — this has happened by accident while writing tests.

`yarn test` covers the arithmetic, the fixture registry and the drift guard, in the `node` project with no DOM at all — the probe's three DOM-touching functions take an injectable `{ document, window }` that the tests stub. That is deliberate: running them in jsdom would give the appearance of a DOM while still measuring nothing.

### React warnings are cached, so a `console.error` spy can pass falsely

React caches each invalid-attribute warning **per attribute name at module scope**: it fires once and is then suppressed for the lifetime of the module. Jest gives each test _file_ a fresh registry, so exactly one render per file can observe it.

A spy placed after another render of the same component therefore passes against broken code. Assertions of this kind get their own file — [`Header.console.test.tsx`](../src/components/Header.console.test.tsx) and `EntryLabel.console.test.tsx` are the pattern, and each holds a single rendering test for that reason.

## Component tests

`@testing-library/react` with `@testing-library/jest-dom` matchers, bootstrapped by [`jest.setup.dom.ts`](../jest.setup.dom.ts), which also enables `StrictMode` so every render is double-invoked the way the app does it. Assert on de-duplicated render sequences rather than by index, or you are asserting on StrictMode.

Static image imports and `mixpanel-browser` are stubbed for this project only. Both otherwise break at _load_ time — an image cannot be parsed by `ts-jest`, and `utils/mixpanel` starts an analytics session at module scope.

### An async wait is a wall-clock budget, so read the wall clock first

`waitFor` and `findBy*` poll until their callback stops throwing or a timeout expires, and that timeout is wall clock. A Jest worker does not get a wall clock to itself: under worker contention the process is simply descheduled, and a chain of a few macrotask turns — a query resolving, React Query batching the notification onto a `setTimeout(0)`, the re-render, the effect, the state update — takes time out of all proportion to the work in it. The same wait in [`useProfileFilterSeed.test.tsx`](../src/utils/explore/useProfileFilterSeed.test.tsx) settled in 8ms on an idle machine and 1703ms on a thrashing one, at the same commit (SCRUM-616).

Two budgets bound this, and they are deliberately unequal:

| Budget                             | Value   | Set in                                      |
| ---------------------------------- | ------- | ------------------------------------------- |
| `asyncUtilTimeout` — one `waitFor` | 5000ms  | [`jest.setup.dom.ts`](../jest.setup.dom.ts) |
| `testTimeout` — one whole `it`     | 20000ms | [`jest.config.js`](../jest.config.js)       |

The inner one is smaller so that it is the one that expires, because it names the element and the text it gave up on; the test timeout only says a number. Both default to 5000ms, which is why the outer one is raised rather than the inner one merely lowered.

**`testTimeout` has to be root-level in `jest.config.js`.** Set inside a `projects` entry it is accepted, echoed back by `jest --showConfig`, and then ignored at runtime — tests still die at 5000ms. `--showConfig` is not evidence here; a deliberately slow test is.

**So check the wall clock before debugging a surprising local failure.** Twenty consecutive runs of the default suite on an idle 10-core machine took 33.7–35.4s, and about 70s with other work on the machine. A multi-minute run with failures scattered across unrelated suites is reporting on the machine, not on the code — raising a timeout will not fix it, and neither will anything else in the test.

## The database suite

`yarn test:db` collects `*.db.test.ts` against a real MySQL. `jest.config.js` excludes those files, so `yarn test` needs no database.

> **It truncates every table before every test.** It reads `TEST_DATABASE_URL` and never `DATABASE_URL`. [`testDatabaseGuard.ts`](../src/utils/testDatabaseGuard.ts) refuses a non-local host, a database whose name lacks a `test` word or contains `prod`/`stag`/`live`/`main`, and a URL pointing at the same database as `DATABASE_URL`. [`integrationDatabase.ts`](../src/testing/integrationDatabase.ts) then refuses any database it did not itself claim. **There is no override.**

`prisma migrate deploy` runs inside it, against that disposable database only. That is not a change to the PlanetScale workflow.

The `test-db` CI job provisions a disposable MySQL 8.0 service container, applies migration history to it and runs this suite on every pull request, so it needs no Docker on your machine to be exercised. It runs twice there, in UTC and in `America/New_York`, for the same reason the mocked suite does — more so here, because `carpool_search` stores `@db.Time(0)` and `@db.Date` columns and these assertions have been through MySQL and back.

What it covers beyond the harness's own self-test: `user.me`'s nested `include` across `user` → `carpool_search` → `location`, the field renames that shape crosses, and the referential actions `relationMode = "prisma"` emulates — including the one that matters, that a delete which bypasses Prisma does **not** cascade. See [the database docs](../src/server/db/README.md#integration-tests-against-a-real-database).

## The end-to-end suite

`yarn test:e2e` drives a real Chromium against a real build against a real MySQL, through Playwright. `yarn test:e2e:install` fetches the browser the first time.

**It is a smoke layer, and the list below is the whole of it.** A green run proves these journeys at these viewports and nothing else — it is not whole-app assurance and must not be reported as any.

All of it lives in [`auth-redirect.e2e.ts`](../e2e/smoke/auth-redirect.e2e.ts), and every row runs at both viewports.

| What is asserted                                             | Kind     |
| ------------------------------------------------------------ | -------- |
| Signed-out visitor at `/` lands on `/sign-in`, which renders | browser  |
| The sign-in control's measured box is inside the viewport    | geometry |
| The project runs at the viewport width it declares           | geometry |
| Without a session cookie, `/` redirects to `/sign-in`        | guard    |
| With one, `/` redirects by onboarding state instead          | guard    |
| An onboarded user is sent off `/sign-in`                     | guard    |
| `permission` and `role` reach the rows they are seeded into  | data     |

Desktop is 1280×800; mobile is `MOBILE_BREAKPOINT_PX - 1` wide, read from [`breakpoints.js`](../src/utils/breakpoints.js) so the suite and the app cannot drift apart. Why only the mobile width is pinned to the breakpoint is argued in [`e2e/support/environment.ts`](../e2e/support/environment.ts).

**Do not assert layout with `scrollWidth`.** `globals.css` sets `html, body { overflow: hidden }`, so a 4000px element appended to `body` leaves `document.documentElement.scrollWidth` at exactly the viewport width — measured at 1280 and 639. A document-overflow assertion cannot fail on any page of this app and would ship looking like geometry while asserting nothing. Measure the element's own box against the viewport, and confirm the inverse fails before trusting it. The same `overflow: hidden` is why it matters: a control outside the viewport here is unreachable, not scrollable-to.

**Four journeys from SCRUM-264 are not here yet** — onboarding, the map and sidebar, sending a carpool request, and the admin dashboard — and neither is the mobile bottom navigation's geometry assertion. Each carries its own stubbing decisions for Mapbox, Pusher and SES; they are separate tickets for that reason.

### Authentication, without Azure AD

No test automates Northeastern sign-in, and no production auth code was changed to make testing possible. NextAuth runs the **database** session strategy here, so a session is a row: the helper in [`e2e/support/session.ts`](../e2e/support/session.ts) inserts a `user` and a `session`, then injects the token as the `next-auth.session-token` cookie. Parameterised by `permission`, `isOnboarded` and `role` — and `role` lives on `CarpoolSearch`, not `User`, so passing one creates a search and its two locations.

The cookie's name depends on the scheme (`__Secure-` prefixed over HTTPS), which is why the config pins `NEXTAUTH_URL` to the HTTP base URL rather than letting it be inferred.

### Decisions worth not re-litigating

- **Screenshot comparison: no.** It is the only thing that would catch a breakpoint converted in the wrong direction, and it is rejected anyway: Tailwind v4 scans the whole repository, so the compiled stylesheet changes when a _comment_ names a utility, and five UI systems coexist in the tree. Snapshots under those conditions fail for reasons unrelated to the change under review, and a suite whose failures are usually noise gets waved through. Computed geometry is asserted instead.
- **The safe-area inset is a third run configuration, and is not built yet.** Chromium defines `env(safe-area-inset-bottom)` as an actual `0px` when no override is set — fallback or no — so a Playwright device descriptor cannot produce one; see [`layoutFixtures.ts:1753`](../src/testing/layoutFixtures.ts). The only mechanism is the CDP call `Emulation.setSafeAreaInsetsOverride`. It belongs on the one assertion that needs it, which is on a journey not yet written. **No test here sets or claims an inset.**
- **Mapbox, Pusher and SES are out of reach of these journeys rather than stubbed.** None of them loads the map, opens a Pusher connection or calls an email procedure. Route-level stubbing is the decided approach for when one does — the env contract supplies a syntactically valid but non-functional Mapbox token, so letting calls through is not an option that works — and is specified per journey. A stub written now against no caller would be unexercised code that drifts.
- **The trigger policy is narrower than every other check.** [`e2e.yml`](../.github/workflows/e2e.yml) runs on pushes to `main` and on `workflow_dispatch`, not on pull requests. The reasoning, and the cost of that trade, are in the file.

### Nothing in `e2e/` may name a Tailwind class

Tailwind v4 scans this whole repository minus what `.gitignore` excludes, and `e2e/` is tracked — so a utility named in a selector, a string or a comment there ships as CSS. **Select by role, accessible name or `data-testid`.** `playwright-report/` and `test-results/` are gitignored for the same reason and not only for tidiness: a trace embeds the page's markup and the report embeds its stylesheet, which would feed the compiled CSS back in as scan input.

### The two runners cannot collect each other's files

Jest takes `*.test.ts(x)` and `*.spec.ts(x)`; Playwright takes `*.e2e.ts` under `e2e/`, which Jest also ignores by path. Two independent guards, because the failure prevented is the quiet one — Jest loading a file written against Playwright's `test` would throw at _load_ time, dropping a whole suite from the run and reporting fewer tests rather than a failure. [`test-runner-separation.test.ts`](../test-runner-separation.test.ts) asserts it from the other side, inside `yarn test`.

### Two databases, and why the guard is not being circumvented

`globalSetup` calls the same `prepareIntegrationDatabase` the Jest database suite uses, so there is one mechanism for claiming, migrating and emptying a disposable MySQL — not two. It truncates **once per run** rather than between tests; every test seeds its own randomly identified user, which is what lets the workers run in parallel.

The Next server has to read the rows the suite seeds, so it is handed the disposable database as its `DATABASE_URL` — **in the child process's environment alone**, exactly as `applyIntegrationMigrations` already hands the URL to the Prisma CLI. This process keeps the two variables distinct, so [`testDatabaseGuard.ts`](../src/utils/testDatabaseGuard.ts) passes on its own terms and a developer's real database is never the truncation target.

## Not covered by any automated run

The suite above is five journeys wide. Everything outside it that depends on layout, paint order or real device behaviour is still unverified: the map, the explore sheet, messaging, the admin console, onboarding, and every safe-area and `dvh` behaviour.

Layout can also be measured by hand, in Chromium, through [the harness above](#measuring-layout-in-a-real-browser) — a tool for taking a measurement, not a test that stops a regression. Nothing invokes it.
