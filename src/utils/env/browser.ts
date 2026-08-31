import { bool, envsafe, makeValidator, str } from "envsafe";

/**
 * Which deployment this build is. The values are an allow-list rather than a
 * free string because this is the most consequential variable in the app and it
 * was the only one not validated at all:
 *
 *  - `staging` enables the Google provider in `[...nextauth].ts`, renders the
 *    Google button in `sign-in.tsx`, and restricts email recipients to
 *    gmail.com in `email.ts`. Set it in production by mistake and anyone with
 *    a Google account could bypass Northeastern SSO.
 *  - the value is written verbatim into every S3 profile-picture key
 *    (`profile-pictures/{env}/{userId}`), so a missing or renamed value orphans
 *    every existing upload. Unset, `uploadToS3` produced the literal key
 *    `profile-pictures/undefined/...`.
 *
 * Production is `production`, which is what these keys already contain — so
 * validating the variable does not move any existing object.
 *
 * `devDefault` keeps local setups working: `.env.example` ships this empty, and
 * envsafe treats an empty string as absent, so a developer who never set it
 * gets `development` instead of a startup failure.
 */
export const DEPLOY_ENVS = ["production", "staging", "development"] as const;

export type DeployEnv = (typeof DEPLOY_ENVS)[number];

/**
 * Narrows the parsed value to `DeployEnv` so a mistyped comparison — the very
 * thing this variable invites, since it is compared to string literals in four
 * places — fails to compile. `envsafe` applies `choices` after this parser, so
 * the runtime rejection is still its own.
 */
const deployEnv = makeValidator<DeployEnv>((input) => input as DeployEnv);

export const browserEnv = envsafe({
  NEXT_PUBLIC_ENV: deployEnv({
    input: process.env.NEXT_PUBLIC_ENV,
    choices: DEPLOY_ENVS,
    devDefault: "development",
  }),
  NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: str({
    input: process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
  }),
  NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN: str({
    input: process.env.NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN,
  }),
  NEXT_PUBLIC_PUSHER_KEY: str({
    input: process.env.NEXT_PUBLIC_PUSHER_KEY,
  }),
  NEXT_PUBLIC_PUSHER_CLUSTER: str({
    input: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
  }),
});
