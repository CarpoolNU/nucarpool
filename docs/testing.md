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

No browser or end-to-end tests exist. Anything that depends on layout, paint order, or real device behaviour is unverified.
