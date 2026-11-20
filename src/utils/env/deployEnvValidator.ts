import { makeValidator } from "envsafe";

/**
 * Which deployment this build is. The values are an allow-list rather than a
 * free string because this is the most consequential variable in the app:
 *
 *  - `staging` enables the Google provider in `[...nextauth].ts`, renders the
 *    Google button in `sign-in.tsx`, and restricts email recipients to
 *    gmail.com in `email.ts`. Set it in production by mistake and anyone with
 *    a Google account could bypass Northeastern SSO.
 *  - the value is written verbatim into every S3 profile-picture key
 *    (`profile-pictures/{env}/{userId}`), so a missing or renamed value orphans
 *    every existing upload. Left unvalidated, an unset value would produce the
 *    literal key `profile-pictures/undefined/...`.
 *
 * Production is `production`, which is what these keys already contain — so
 * validating the variable does not move any existing object.
 *
 * **This module validates nothing on its own.** It holds only the definitions,
 * so that `browser.ts` and `deployEnv.ts` can share them without either one
 * importing the other: importing `browser.ts` runs its whole `envsafe` group,
 * which is exactly what `deployEnv.ts` exists to avoid. No environment read
 * belongs here — `scripts/check-env-contract.js` derives the contract from the
 * reads in `browser.ts` and `server.ts`, and would not see one in this file.
 */
export const DEPLOY_ENVS = ["production", "staging", "development"] as const;

export type DeployEnv = (typeof DEPLOY_ENVS)[number];

/**
 * Narrows the parsed value to `DeployEnv` so a mistyped comparison — the very
 * thing this variable invites, since it is compared to string literals in four
 * places — fails to compile. `envsafe` applies `choices` after this parser, so
 * the runtime rejection is still its own.
 */
export const deployEnvValidator = makeValidator<DeployEnv>(
  (input) => input as DeployEnv,
);
