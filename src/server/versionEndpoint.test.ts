/**
 * HTTP contract of the build-identity endpoint.
 *
 * `buildInfo.test.ts` covers the value itself. This covers the route around
 * it: the method rule, the cache rule, and - the one that matters most - that
 * the serialized response carries build identity and nothing else.
 *
 * Deliberately NOT co-located with the handler. Under `src/pages/` a filename
 * is also a route: Next's default `pageExtensions` includes `.ts`, so
 * `version.test.ts` beside the handler would be compiled and shipped as
 * `/api/version.test`. `pusherAuthEndpoint.test.ts` established this placement
 * and `scripts/check-page-routes.js` enforces it in the `build` job.
 */

import type { NextApiRequest, NextApiResponse } from "next";

import handler from "../pages/api/version";
import { UNKNOWN_BUILD_VALUE } from "./buildInfo";

const buildRes = () => {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: jest.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as NextApiResponse & {
    statusCode: number;
    body: unknown;
    setHeader: jest.Mock;
  };
};

const call = (req: Partial<NextApiRequest> = {}) => {
  const res = buildRes();
  handler({ method: "GET", ...req } as NextApiRequest, res);
  return res;
};

/**
 * The build variables are absent locally and in CI - they are not in the
 * `envsafe` contract, so `jest.setup.env.js` does not fabricate them either.
 * Tests that need a populated container set them and restore afterwards.
 */
const withBuildEnv = <T>(vars: Record<string, string>, run: () => T): T => {
  const saved = new Map(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, vars);
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

describe("GET /api/version", () => {
  it("serves the commit the build came from", () => {
    const res = withBuildEnv(
      {
        AWS_COMMIT_ID: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
        AWS_BRANCH: "main",
        AWS_JOB_ID: "42",
      },
      () => call(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
      branch: "main",
      jobId: "42",
    });
  });

  it("exposes build identity and nothing else", () => {
    /*
     * that change's third acceptance criterion, asserted against the response
     * body rather than by reading the source. The risk this guards is not
     * today's code - it is the plausible future change that adds "just the
     * non-secret config" to a diagnostic endpoint nobody is watching.
     *
     * Asserted as an exact key set, so an added field fails rather than
     * passing a subset check. `buildInfo.test.ts` pins the same thing one
     * layer in.
     */
    const res = call();

    expect(Object.keys(res.body as object).sort()).toEqual([
      "branch",
      "commit",
      "environment",
      "jobId",
    ]);
  });

  it("reports unknown rather than throwing when the metadata is absent", () => {
    // Every non-Amplify environment: local `yarn dev`, and the CI build. The
    // endpoint has to answer, because a 500 here is indistinguishable from a
    // deployment that is simply broken.
    const res = call();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ commit: UNKNOWN_BUILD_VALUE });
  });

  it("forbids caching, so it cannot answer for the previous build", () => {
    /*
     * Amplify serves through CloudFront. A cached response would keep
     * reporting the old commit across exactly the deploy boundary this
     * endpoint exists to observe - and would look like a correct answer while
     * doing it, which is worse than the gap this endpoint closes.
     */
    const res = call();

    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store, max-age=0",
    );
  });

  it("refuses anything but GET, and says so", () => {
    const res = call({ method: "POST" });

    expect(res.statusCode).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
  });

  it("does not leak build identity through a rejected method", () => {
    // A 405 body is an error message, not a partial response - so the method
    // rule cannot be bypassed for the information it guards.
    const res = call({ method: "DELETE" });

    expect(res.body).toEqual({ message: "Method not allowed" });
  });
});
