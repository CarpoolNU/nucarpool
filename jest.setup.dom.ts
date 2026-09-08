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
configure({ reactStrictMode: true });
