/**
 * Where the end-to-end suite points, and what the application it boots is told.
 *
 * ## The one thing to read before editing anything in `e2e/`
 *
 * **Tailwind v4 scans this whole repository for class names, minus what
 * `.gitignore` excludes — and `e2e/` is tracked.** So a Tailwind utility named
 * anywhere under this directory, in a selector, in a string, or in a comment,
 * is emitted into the production stylesheet. There is no configuration that
 * narrows the scan; `tailwind.config.js` cannot express it.
 *
 * The consequence for how these tests are written: **select by role, by
 * accessible name, or by `data-testid` — never by a Tailwind class.** A
 * `page.locator(".flex")` would ship `.flex` as CSS forever, and a negative
 * assertion about a class ships it too. `CLAUDE.md` carries the rule and
 * `docs/testing.md` carries the measurement behind it.
 *
 * ## Two databases, and why the guard is not being circumvented
 *
 * `testDatabaseGuard.ts` refuses a `TEST_DATABASE_URL` that addresses the same
 * database as `DATABASE_URL`. That rule exists because the harness `TRUNCATE`s
 * what it is pointed at, and the variable most likely to be pointed at by
 * accident is the application's own.
 *
 * An end-to-end run needs the opposite of isolation in one specific place: the
 * Next server has to read the rows the suite seeds, so *that server* must use
 * the disposable database. Both things are true at once because they are
 * different processes:
 *
 *   - **this process** keeps `TEST_DATABASE_URL` and `DATABASE_URL` distinct,
 *     so the guard passes on its own terms and the developer's real database
 *     is never the truncation target;
 *   - **the Next child process** is handed `DATABASE_URL` set to the approved
 *     disposable target, in its environment alone.
 *
 * That is not a new trick. `applyIntegrationMigrations` in
 * `src/testing/integrationDatabase.ts` already runs the Prisma CLI exactly this
 * way, and says why: the child needs the URL, and this process must not have
 * its own changed underneath it.
 */

import {
  approvedIntegrationTarget,
  type ApprovedTarget,
} from "../../src/testing/integrationDatabase";
import { MOBILE_BREAKPOINT_PX } from "../../src/utils/breakpoints";

/**
 * The port the suite boots the built app on.
 *
 * **Deliberately not 3000.** Port 3000 is `yarn dev`, and the README notes that
 * only one worktree at a time can hold it — this repository is routinely
 * checked out several times at once under `.claude/worktrees/`. An end-to-end
 * run that took 3000 would either fail or, worse, silently test whichever
 * branch's dev server happened to be listening.
 */
export const E2E_PORT = Number.parseInt(process.env.E2E_PORT ?? "3100", 10);

/**
 * `127.0.0.1` rather than `localhost`, so the origin cannot resolve through
 * IPv6 on one machine and IPv4 on another. Cookies are scoped by host, and a
 * cookie set on `127.0.0.1` is not sent to `localhost`.
 */
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * The cookie NextAuth reads under the database-session strategy.
 *
 * **The name depends on the scheme**: NextAuth prefixes it `__Secure-` when it
 * believes it is serving HTTPS, which it decides from `NEXTAUTH_URL`. This
 * suite is HTTP, and {@link appServerEnv} pins `NEXTAUTH_URL` to
 * {@link E2E_BASE_URL} so that decision cannot drift from this constant.
 */
export const SESSION_COOKIE_NAME = "next-auth.session-token";

/**
 * The mobile viewport, pinned one pixel below the application's own boundary.
 *
 * `isMobileWidth` is `width < MOBILE_BREAKPOINT_PX`, so this is the widest
 * viewport that still counts as mobile. Taking it from `breakpoints.js` rather
 * than hard-coding 639 is what stops the suite and the app from drifting apart
 * when the breakpoint moves — the same reasoning, and the same source, as
 * `MOBILE_WIDTH` in `src/testing/viewport.ts`.
 *
 * The height is a plain tall-phone figure and is not derived from anything.
 * Nothing in this repository branches on viewport height below the `desktop`
 * boundary, so there is no value to pin it to.
 */
export const MOBILE_VIEWPORT = {
  width: MOBILE_BREAKPOINT_PX - 1,
  height: 844,
} as const;

/**
 * The desktop viewport.
 *
 * **Not pinned to the breakpoint, unlike the mobile one, and that asymmetry is
 * deliberate.** `src/testing/viewport.ts` sets `DESKTOP_WIDTH` to exactly
 * `MOBILE_BREAKPOINT_PX` so that an off-by-one in the comparison fails a test;
 * that check is worth having and it already exists, in jsdom, where it costs
 * nothing. Repeating it here would buy the same assertion a second time while
 * making every desktop assertion in this suite run at 640px — a width no
 * desktop user has, and one at which a genuine desktop layout problem would be
 * indistinguishable from the layout simply being cramped.
 *
 * So the two layers answer different questions: jsdom guards the boundary,
 * and this guards a representative desktop.
 */
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * The approved disposable database, or a thrown `TestDatabaseGuardError`
 * explaining why there is not one.
 *
 * Re-exported rather than re-derived so there is exactly one implementation of
 * "which database may this be run against", shared with `yarn test:db`.
 */
export const e2eDatabaseTarget = (): ApprovedTarget =>
  approvedIntegrationTarget();

/**
 * The environment the Next server is started with.
 *
 * Only the two values that must not be inherited are set. Everything else
 * reaches the child through `process.env`, which is `.env` on a developer's
 * machine and the env contract's placeholders in CI — so this cannot drift
 * from `scripts/check-env-contract.js`, and no end-to-end-only copy of the
 * variable list exists to rot.
 *
 * `NEXTAUTH_URL` is not one of the envsafe-validated variables, so setting it
 * is additive: NextAuth reads `process.env` directly for it. It is pinned
 * because NextAuth derives the session cookie's name from the scheme, and
 * {@link SESSION_COOKIE_NAME} has to be right or every seeded session is
 * silently anonymous.
 */
export const appServerEnv = (
  target: ApprovedTarget,
): Record<string, string> => ({
  DATABASE_URL: target.url,
  NEXTAUTH_URL: E2E_BASE_URL,
});
