/**
 * Runs once, before Playwright starts the web server or any worker.
 *
 * It does exactly what `jest.integration.globalSetup.js` does, through the same
 * function, because the two suites have the same need: approve the target,
 * build its schema from committed migration history, prove it is reachable, and
 * leave it empty. Reusing `prepareIntegrationDatabase` rather than writing a
 * second version of it is the point — SCRUM-263 established that mechanism and
 * this ticket was explicitly scoped to reuse it.
 *
 * **Ordering matters.** Playwright runs `globalSetup` before `webServer`, so
 * the Next server is started against a database that already has its schema. A
 * refused or unreachable target therefore produces one clear message here
 * rather than a wall of 500s from a booted app.
 *
 * **This is the only point at which the database is emptied.** Unlike the Jest
 * integration suite, nothing truncates between tests: `seedSessionUser` gives
 * every test its own randomly identified user, so tests do not collide and the
 * workers can run in parallel. See the note on it for why that trade is worth
 * making for a browser suite and not for a mocked one.
 */

import { prepareIntegrationDatabase } from "../src/testing/integrationDatabase";

const globalSetup = async (): Promise<void> => {
  await prepareIntegrationDatabase();
};

export default globalSetup;
