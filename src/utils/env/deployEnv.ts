import { envsafe } from "envsafe";
import { DEPLOY_ENVS, deployEnvValidator } from "./deployEnvValidator";

/**
 * `NEXT_PUBLIC_ENV`, validated on its own.
 *
 * `browserEnv` validates all five `NEXT_PUBLIC_*` variables as one `envsafe`
 * group, which throws at import time if any is missing. That is right for the
 * app, which uses all five. It is wrong for code that needs only this one —
 * `emailParams.ts`, for staging's gmail-only recipient filter — when that code
 * also runs outside the app: the weekly report-digest Lambda bundles
 * `emailParams.ts`, and importing `browserEnv` there meant deploying Mapbox,
 * Mixpanel and Pusher values into a job that sends one email a week.
 *
 * **The validation is the same as `browserEnv.NEXT_PUBLIC_ENV`'s, not a
 * relaxed copy.** Same allow-list, same parser, same `devDefault`, so a value
 * either module accepts the other accepts too, and a deployment cannot be
 * `staging` to the app and something else to the email filter.
 * `deployEnv.test.ts` checks that across every input class rather than
 * trusting the two option blocks to stay identical by eye.
 *
 * This file must not read any variable `browser.ts` does not. The environment
 * contract (`scripts/check-env-contract.js`) is derived from `browser.ts` and
 * `server.ts` only, and a variable added here alone would be required at
 * runtime yet absent from `.env.example`, `amplify.yml` and CI's placeholders.
 * A test enforces that too.
 */
export const deployEnv = envsafe({
  NEXT_PUBLIC_ENV: deployEnvValidator({
    input: process.env.NEXT_PUBLIC_ENV,
    choices: DEPLOY_ENVS,
    devDefault: "development",
  }),
});
