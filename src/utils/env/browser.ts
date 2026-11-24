import { bool, envsafe, str } from "envsafe";
import { DEPLOY_ENVS, deployEnvValidator } from "./deployEnvValidator";

/**
 * `NEXT_PUBLIC_ENV`'s allow-list, its type and its parser live in
 * `deployEnvValidator.ts`, which explains why the variable is validated at
 * all. They are re-exported here so existing imports keep working.
 *
 * `deployEnv.ts` validates `NEXT_PUBLIC_ENV` again on its own, for code that
 * needs that one variable without the other four — the report-digest Lambda.
 * The options below are deliberately written out rather than shared, because
 * `scripts/check-env-contract.js` reads them from this file's text; a test in
 * `deployEnv.test.ts` holds the two validators to the same answers.
 *
 * `devDefault` keeps local setups working: `.env.example` ships this empty, and
 * envsafe treats an empty string as absent, so a developer who never set it
 * gets `development` instead of a startup failure.
 */
export { DEPLOY_ENVS };
export type { DeployEnv } from "./deployEnvValidator";

export const browserEnv = envsafe({
  NEXT_PUBLIC_ENV: deployEnvValidator({
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
  /**
   * Whether Community is reachable (SCRUM-741). Off unless a deployment says
   * otherwise, so the schema and code can ship ahead of it; turning it back
   * off is the intended rollback. While off, every `community.*` procedure
   * refuses: see `communityServicesFor` in `src/server/communityHost.ts`.
   *
   * `default`, not `devDefault`, so an environment that never sets it is off
   * in production as well as locally.
   */
  NEXT_PUBLIC_COMMUNITY_ENABLED: bool({
    input: process.env.NEXT_PUBLIC_COMMUNITY_ENABLED,
    default: false,
  }),
});
