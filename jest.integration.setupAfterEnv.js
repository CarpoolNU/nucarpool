"use strict";

/**
 * Per-test isolation for the integration suite.
 *
 * Runs once per test file, inside the worker, and registers the hooks every
 * database-backed suite needs. Registered centrally rather than repeated in
 * each file so that a new suite is isolated whether or not its author
 * remembered to be - order-independence is a property of the configuration
 * here, not of a convention.
 *
 * **Truncation happens before every test, not after.** Before, so a suite
 * starts clean even when the previous one crashed part-way and left rows
 * behind; and only ever truncating on the way in means a failing test's rows
 * are still there to inspect when it fails.
 *
 * The consequence for anyone writing a test here: build fixtures in
 * `beforeEach` or in the test body. A `beforeAll` insert is truncated before
 * the first test that would have read it.
 */

const {
  resetIntegrationDatabase,
  disconnectIntegrationDatabase,
} = require("./src/testing/integrationDatabase");

beforeEach(async () => {
  await resetIntegrationDatabase();
});

afterAll(async () => {
  await disconnectIntegrationDatabase();
});
