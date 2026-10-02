/**
 * jsdom project bootstrap — runs after the test framework is installed.
 *
 * `@testing-library/jest-dom` extends `expect` with DOM matchers
 * (`toBeInTheDocument`, `toBeDisabled`, `toHaveFocus`, …). It has to be
 * registered here rather than in `setupFiles`, which runs *before* the
 * framework exists — there is no `expect` to extend at that point.
 *
 * This is a `.ts` file, so `tsconfig.json`'s `include` picks it up and the
 * package's global type augmentation enters the program. That is what makes
 * `expect(el).toBeInTheDocument()` typecheck under `yarn tsc`, which matters
 * more than usual here: `tsconfig.json` pins `"types": ["jest", "node"]`, so
 * TypeScript 6 loads *only* those two ambient packages and an `@types`-style
 * declaration file would be ignored. Reaching the augmentation through a real
 * import is the only route that works.
 */

import { configure } from "@testing-library/react";
import "@testing-library/jest-dom";

/**
 * Every component test renders inside `<StrictMode>`, because the application
 * does: `next.config.js` sets `reactStrictMode: true`.
 *
 * This is not a detail. StrictMode double-invokes render functions, state
 * updaters and effects in development, which is precisely what turns a side
 * effect written in the wrong place into a visible defect — the 2026-09-08
 * audit found an unread-count increment living *inside* a `setState` updater,
 * a bug whose entire symptom is that StrictMode runs it twice. Testing library
 * defaults this off, so the default has to be overridden here rather than
 * remembered per file: a component test that quietly ran without StrictMode
 * while production runs with it would assert the wrong behaviour and still
 * pass.
 *
 * The cost is that a genuinely non-idempotent effect now fails its test. That
 * is the intended outcome.
 */

/**
 * `asyncUtilTimeout` is how long `waitFor`, `findBy*` and friends keep polling
 * before giving up. Testing Library's default is 1000ms.
 *
 * That default is a wall-clock budget, and a Jest worker does not get a wall
 * clock to itself. Under worker contention the process is simply descheduled,
 * so an async chain that needs a few macrotask turns - a React Query fetch
 * resolving, `notifyManager` batching the notification onto a `setTimeout(0)`,
 * the re-render, the effect, the state update, the second re-render - takes
 * wall-clock time out of all proportion to the work in it.
 *
 * Measured on `src/utils/explore/useProfileFilterSeed.test.tsx` (SCRUM-616), a
 * 10-core machine, same commit, varying only `--maxWorkers`:
 *
 *     isolated file          3.5s run        4-23ms to settle
 *     9 workers (default)   55-69s run         8-9ms
 *     32 workers              101s run      134-157ms
 *     64 workers              150s run      190-852ms
 *     96 workers              272s run     175-1703ms   <- exceeds 1000ms
 *
 * The suite's logic is not the variable: the number of polls stays at three or
 * four throughout, so nothing is waiting on an event that never comes. Only the
 * wall clock moves, and at 1000ms the margin over a healthy run is ~250x on an
 * idle machine and under 2x on a loaded one. CI runs the jsdom project twice
 * (UTC and `America/New_York`), so a loaded runner gets two chances to lose.
 *
 * Polling is the right shape for these waits and the budget is the defect. What
 * is being awaited is "the component has rendered the end state", and the
 * number of macrotask hops to get there is React Query's business, not ours - a
 * barrier that encoded the hop count would be coupled to a dependency's
 * internals and would break on its next minor. The repository has 103 `waitFor`
 * call sites and none sets its own timeout, so this is a property of the suite
 * as a whole rather than of one test.
 *
 * Raising it costs nothing on a green run: `waitFor` resolves as soon as its
 * callback stops throwing, so the timeout is only ever reached by a test that
 * was going to fail anyway. The cost is paid exclusively in how long a genuine
 * failure takes to report, which is why this is 5000ms and not larger -
 * `jest.config.js` pins `testTimeout` above it so that this is the bound that
 * expires first and names what it was waiting for.
 *
 * This moves the threshold; it does not remove it. One 96-worker run thrashed
 * badly enough to take 798s, and the same wait then measured 44597ms - a
 * timeout is wall-clock, and a process that is not scheduled cannot observe its
 * own deadline either. No budget survives that, and a run in that state has
 * failures scattered across dozens of unrelated suites. Wall clock is the first
 * thing to read on a surprising local failure: twenty consecutive runs on an
 * idle 10-core machine took 33.7-35.4s, so a multi-minute run is reporting on
 * the machine, not on the code.
 */
configure({ reactStrictMode: true, asyncUtilTimeout: 5000 });
