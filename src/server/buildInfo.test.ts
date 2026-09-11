/**
 * `readBuildInfo`, the half of SCRUM-405 that is testable locally.
 *
 * The endpoint's whole value comes from variables that only exist inside an
 * Amplify build container, so nothing here proves the deploy works - that
 * needs one real deploy and a `curl`, and the ticket says so. What these do
 * cover is every way the value can be absent, which is the half that would
 * otherwise be discovered in production as `"commit":""`.
 */

import {
  readBuildInfo,
  UNKNOWN_BUILD_VALUE,
  type BuildInfo,
} from "./buildInfo";

/** A populated Amplify container, as far as this module is concerned. */
const DEPLOYED = {
  AWS_COMMIT_ID: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
  AWS_BRANCH: "main",
  AWS_JOB_ID: "42",
  NEXT_PUBLIC_ENV: "production",
};

describe("readBuildInfo", () => {
  it("reports what the build container set", () => {
    expect(readBuildInfo(DEPLOYED)).toEqual<BuildInfo>({
      commit: DEPLOYED.AWS_COMMIT_ID,
      branch: "main",
      jobId: "42",
      environment: "production",
    });
  });

  it("returns exactly the four documented fields and no others", () => {
    /*
     * The acceptance criterion that nothing beyond build identity is exposed,
     * as an assertion rather than a promise. A later change that spread
     * `process.env` into the response, or added a `config` field, fails here
     * and in `versionEndpoint.test.ts` - which asserts the same thing about
     * the serialized response, one layer further out.
     */
    expect(Object.keys(readBuildInfo(DEPLOYED)).sort()).toEqual([
      "branch",
      "commit",
      "environment",
      "jobId",
    ]);
  });

  it("degrades to a stated unknown when nothing is set", () => {
    // The local and CI case. `envsafe` does not know about these variables, so
    // nothing fails earlier and this is the behaviour that ships.
    expect(readBuildInfo({})).toEqual<BuildInfo>({
      commit: UNKNOWN_BUILD_VALUE,
      branch: UNKNOWN_BUILD_VALUE,
      jobId: UNKNOWN_BUILD_VALUE,
      environment: UNKNOWN_BUILD_VALUE,
    });
  });

  it("treats an empty value as absent rather than reporting it", () => {
    /*
     * The case that actually reaches production if it is wrong. A `grep` that
     * matches a variable set to nothing appends `AWS_COMMIT_ID=` to
     * `.env.production`, which arrives as `""` - so the naive
     * `?? UNKNOWN` spelling would serve `"commit":""` and read as a broken
     * endpoint rather than a missing value.
     */
    expect(
      readBuildInfo({ AWS_COMMIT_ID: "", AWS_BRANCH: "   " }),
    ).toMatchObject({
      commit: UNKNOWN_BUILD_VALUE,
      branch: UNKNOWN_BUILD_VALUE,
    });
  });

  it("trims surrounding whitespace off a real value", () => {
    // Cheap, and it means a stray newline in `.env.production` cannot produce
    // a SHA that fails to match anything in `git`.
    expect(readBuildInfo({ AWS_COMMIT_ID: " abc123 \n" }).commit).toBe(
      "abc123",
    );
  });

  it("reports each field independently", () => {
    // A partially populated container is the realistic failure, not an empty
    // one: this asserts a missing branch does not take the commit with it.
    const info = readBuildInfo({ AWS_COMMIT_ID: "abc123" });

    expect(info.commit).toBe("abc123");
    expect(info.branch).toBe(UNKNOWN_BUILD_VALUE);
  });

  it("defaults to the real process environment", () => {
    // Pins that the no-argument call the route makes is wired to something.
    // Asserting the shape rather than the values, which depend on where this
    // runs - `AWS_COMMIT_ID` is unset locally and in CI, and set on Amplify.
    expect(Object.keys(readBuildInfo()).sort()).toEqual([
      "branch",
      "commit",
      "environment",
      "jobId",
    ]);
  });
});
