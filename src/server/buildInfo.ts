/**
 * Which build is running.
 *
 * The deployed app published no build identifier, so "has Amplify shipped the
 * commit containing change X?" had no answer short of asking someone with
 * console access. That is not a cosmetic gap: SCRUM-287 and SCRUM-366 both
 * carry "the new code is deployed" as a blocking precondition on an
 * irreversible database change, and both stalled on it. The workaround
 * attempted in each was to infer the deploy from row data, and it failed the
 * same way both times - zero rows is equally consistent with "not deployed"
 * and with "deployed, and nobody has exercised the feature since".
 *
 * Amplify's build container sets `AWS_COMMIT_ID`, `AWS_BRANCH` and
 * `AWS_JOB_ID`; `amplify.yml` now copies those three into `.env.production`
 * alongside every other runtime variable, and `pages/api/version.ts` serves
 * them. This module is the part worth testing, which is why it is here rather
 * than in the route: under `src/pages/` a filename is also a URL.
 *
 * ---
 *
 * **These four fields, and deliberately nothing else.** The temptation in a
 * diagnostic endpoint is to widen it later - a spread of `process.env`, the
 * resolved config, "just the non-secret ones". The type below is the whole
 * contract, it is built field by field from named reads, and there is a test
 * asserting the response has exactly these keys. An endpoint that grew a
 * `config` field would fail it.
 *
 * **Not in the `envsafe` contract, on purpose.** `src/utils/env/*.ts` define
 * what the app *requires*; a missing entry there stops the build. Build
 * metadata is not required for the app to function, and it does not exist
 * outside an Amplify container - so adding it would fail every local `yarn
 * dev` and every CI build for a value nothing depends on. It is read straight
 * from the environment here and degrades to `UNKNOWN_BUILD_VALUE` instead.
 *
 * The side effect of staying out of the contract is that
 * `check-env-contract.js --amplify` classifies the new grep lines as
 * *unconstrained* - it neither requires nor forbids `|| true` on them. See
 * `amplify.yml` for why they are nonetheless strict.
 */

/** What every field reports when its variable is absent. */
export const UNKNOWN_BUILD_VALUE = "unknown";

/**
 * The response body of `/api/version`, and the exhaustive list of what the
 * deployed app will tell an anonymous caller about itself.
 */
export interface BuildInfo {
  /** `AWS_COMMIT_ID` - the git SHA Amplify built. The field that matters. */
  commit: string;
  /** `AWS_BRANCH` - which Amplify branch's pipeline produced it. */
  branch: string;
  /** `AWS_JOB_ID` - the build number, for finding the job in the console. */
  jobId: string;
  /** `NEXT_PUBLIC_ENV` - which deployment this is. */
  environment: string;
}

/**
 * What `readBuildInfo` needs of an environment: string-valued keys, read-only.
 *
 * Deliberately not `NodeJS.ProcessEnv`. Next augments that type to make
 * `NODE_ENV` **required**, so every test fixture would have to carry a
 * `NODE_ENV` this module never reads - and `tsc` rejects the ones that do not,
 * while `ts-jest` lets them through, so the mismatch surfaces only in CI. This
 * type says what is actually used, and `process.env` satisfies it.
 */
export type BuildEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Reads one variable, treating absent, empty and whitespace-only alike.
 *
 * The empty-string case is the one that matters and is easy to miss: a `grep`
 * that matches a variable set to nothing writes `AWS_COMMIT_ID=` into
 * `.env.production`, which arrives as `""` rather than `undefined`. Reporting
 * that as a commit would render as an empty string in the response and read as
 * a bug in the endpoint rather than a missing value.
 */
const read = (value: string | undefined): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : UNKNOWN_BUILD_VALUE;
};

/**
 * Assembles the build identity from an environment.
 *
 * Takes the environment as an argument rather than reaching for
 * `process.env` directly so that the absent, empty and populated cases are all
 * reachable from a test. The route calls it with no argument.
 *
 * `NEXT_PUBLIC_ENV` is read from the environment here like the other three,
 * rather than through `browserEnv`. It is echoed verbatim, which is safe
 * because `src/utils/env/browser.ts` validates it against `DEPLOY_ENVS` at
 * import time - so in a *running* app the only values this can return are
 * those three or `UNKNOWN_BUILD_VALUE`. A junk value fails app startup long
 * before it could reach this response.
 */
export const readBuildInfo = (
  environment: BuildEnvironment = process.env,
): BuildInfo => ({
  commit: read(environment.AWS_COMMIT_ID),
  branch: read(environment.AWS_BRANCH),
  jobId: read(environment.AWS_JOB_ID),
  environment: read(environment.NEXT_PUBLIC_ENV),
});
