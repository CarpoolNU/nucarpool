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
3. **Nothing runs it.** It is not in `yarn test`, not in CI, not scheduled. A criterion measured through it is measured once, by someone who chose to. The class-name assertions the mobile tickets left behind are still the only standing guard, and they are proxies. Making these durable means a browser in CI, which means a new dev dependency; SCRUM-481 decided against that deliberately rather than by omission.

Four edges are paid for and encoded rather than left to be rediscovered:

- **Probe a grid, never a centre point.** `gridPoints` has no single-point option. SCRUM-476 measured one control's centre, found it clear, and recorded it safe; the hazard was its left third.
- **Every `elementFromPoint` is viewport-guarded, structurally.** That call returns `null` both for "nothing is there" and for "outside the viewport", so an off-screen probe reads as the reassuring answer. `plannedProbePoints` removes off-screen points before the DOM is asked, and reports `measurable: false` when it removed all of them — which is a different result from "probed and found nothing".
- **A height criterion reads `clientHeight`, not the rect.** Tailwind v4 compiles `divide-y` to `:where(.divide-y > :not(:last-child)) { border-bottom-width: 1px }`, so every row **but the last** carries a border pixel — the opposite end of the list from v3's `& > * + *`. The group-card fixture holds a bordered and an unbordered row so the 73-versus-72 difference is observable rather than asserted.
- **One stylesheet is only sound when every utility both variants need is still emitted.** Reverting `p-3` to `px-3 py-2` needs no second build, because both are in use elsewhere in the repo; a change to a scan _input_ needs two (SCRUM-467). And remember the scan reaches this whole repository, comments included: naming a utility in a test comment ships it as CSS, which happened while writing these tests and cost 52 bytes of production stylesheet.

`yarn test` covers the arithmetic, the fixture registry and the drift guard, in the `node` project with no DOM at all — the probe's three DOM-touching functions take an injectable `{ document, window }` that the tests stub. That is deliberate: running them in jsdom would give the appearance of a DOM while still measuring nothing.

### React warnings are cached, so a `console.error` spy can pass falsely

React caches each invalid-attribute warning **per attribute name at module scope**: it fires once and is then suppressed for the lifetime of the module. Jest gives each test _file_ a fresh registry, so exactly one render per file can observe it.

A spy placed after another render of the same component therefore passes against broken code. Assertions of this kind get their own file — [`Header.console.test.tsx`](../src/components/Header.console.test.tsx) and `EntryLabel.console.test.tsx` are the pattern, and each holds a single rendering test for that reason.

## Component tests

`@testing-library/react` with `@testing-library/jest-dom` matchers, bootstrapped by [`jest.setup.dom.ts`](../jest.setup.dom.ts), which also enables `StrictMode` so every render is double-invoked the way the app does it. Assert on de-duplicated render sequences rather than by index, or you are asserting on StrictMode.

Static image imports and `mixpanel-browser` are stubbed for this project only. Both otherwise break at _load_ time — an image cannot be parsed by `ts-jest`, and `utils/mixpanel` starts an analytics session at module scope.

## The database suite

`yarn test:db` collects `*.db.test.ts` against a real MySQL. `jest.config.js` excludes those files, so `yarn test` needs no database.

> **It truncates every table before every test.** It reads `TEST_DATABASE_URL` and never `DATABASE_URL`. [`testDatabaseGuard.ts`](../src/utils/testDatabaseGuard.ts) refuses a non-local host, a database whose name lacks a `test` word or contains `prod`/`stag`/`live`/`main`, and a URL pointing at the same database as `DATABASE_URL`. [`integrationDatabase.ts`](../src/testing/integrationDatabase.ts) then refuses any database it did not itself claim. **There is no override.**

`prisma migrate deploy` runs inside it, against that disposable database only. That is not a change to the PlanetScale workflow.

The `test-db` CI job provisions a disposable MySQL 8.0 service container, applies migration history to it and runs this suite on every pull request, so it needs no Docker on your machine to be exercised. It runs twice there, in UTC and in `America/New_York`, for the same reason the mocked suite does — more so here, because `carpool_search` stores `@db.Time(0)` and `@db.Date` columns and these assertions have been through MySQL and back.

What it covers beyond the harness's own self-test: `user.me`'s nested `include` across `user` → `carpool_search` → `location`, the field renames that shape crosses, and the referential actions `relationMode = "prisma"` emulates — including the one that matters, that a delete which bypasses Prisma does **not** cascade. See [the database docs](../src/server/db/README.md#integration-tests-against-a-real-database).

## Not covered at all

No **automated** browser or end-to-end tests exist, and nothing in CI opens a browser. Anything that depends on layout, paint order, or real device behaviour is unverified by any run.

Layout can be measured by hand, in Chromium, through [the harness above](#measuring-layout-in-a-real-browser) — but that is a tool for taking a measurement, not a test that stops a regression. Nothing invokes it.
