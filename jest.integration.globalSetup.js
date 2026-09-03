"use strict";

/**
 * `globalSetup` for the integration suite.
 *
 * A thin shim on purpose: the logic is in TypeScript, where it is type checked
 * by `yarn tsc` and linted by `yarn lint`, and this file only reaches it.
 *
 * Note what is *not* available here. Jest does not apply `setupFiles` to
 * `globalSetup`, so the envsafe placeholders from `jest.setup.env.js` are
 * absent and `process.env` holds only the real environment. That is correct
 * for this file's purpose - the target has to come from the shell or from CI,
 * never from a test default - and it is why the harness must not import
 * anything that validates `serverEnv` at module scope.
 */

module.exports = async () => {
  const {
    prepareIntegrationDatabase,
  } = require("./src/testing/integrationDatabase");

  await prepareIntegrationDatabase();
};
