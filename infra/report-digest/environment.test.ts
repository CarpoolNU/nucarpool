/**
 * The environment the report-digest Lambda needs in order to start.
 *
 * `template.yaml` gives the function `DATABASE_URL`, `NEXT_PUBLIC_ENV` and an
 * optional `REGION_AWS`, and nothing else from the application's contract. The
 * handler's module graph validates environment variables at import time —
 * `emailParams.ts` reads `NEXT_PUBLIC_ENV` through `envsafe` — so a variable
 * the graph requires but the template does not supply fails the function
 * before its first line runs. This file loads the real handler, with its real
 * imports, under exactly the template's environment.
 *
 * It is the Jest-side counterpart of the `lambda-bundle` workflow, which
 * requires the *built* bundle under the same environment. This one runs on
 * every PR and names the failing module; that one proves esbuild's output and
 * the Prisma externals agree.
 *
 * `NODE_ENV=production` throughout, so that `devDefault` does not quietly
 * supply `NEXT_PUBLIC_ENV`. The Lambda runtime does not set `NODE_ENV` at all;
 * see the last test for what that means.
 */

export {};

const UNUSED_BY_THE_DIGEST = [
  "NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN",
  "NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN",
  "NEXT_PUBLIC_PUSHER_KEY",
  "NEXT_PUBLIC_PUSHER_CLUSTER",
] as const;

/** A well-formed URL that nothing listens on. Requiring the handler connects to nothing. */
const DATABASE_URL = "mysql://lambda:lambda@127.0.0.1:1/digest";

let savedEnv: NodeJS.ProcessEnv;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  savedEnv = process.env;
  jest.resetModules();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = savedEnv;
  errorSpy.mockRestore();
});

/**
 * Replaces the environment wholesale — not merely deleting four names — so a
 * variable some other suite's setup happened to provide cannot satisfy the
 * graph by accident. `PATH` is kept because Node and its children expect it.
 */
const useOnly = (env: Record<string, string>) => {
  process.env = { PATH: savedEnv.PATH, ...env } as unknown as NodeJS.ProcessEnv;
};

const loadHandler = () => require("./handler") as typeof import("./handler");

const loadRecipientFilter = () =>
  (
    require("../../src/server/emailParams") as typeof import("../../src/server/emailParams")
  ).isDeliverableRecipient;

describe("the handler starts with only the template's variables", () => {
  it("loads with DATABASE_URL and NEXT_PUBLIC_ENV alone", () => {
    useOnly({
      NODE_ENV: "production",
      DATABASE_URL,
      NEXT_PUBLIC_ENV: "production",
    });

    for (const name of UNUSED_BY_THE_DIGEST) {
      expect(process.env[name]).toBeUndefined();
    }
    expect(typeof loadHandler().handler).toBe("function");
  });

  it("loads with the optional REGION_AWS as well", () => {
    useOnly({
      NODE_ENV: "production",
      DATABASE_URL,
      NEXT_PUBLIC_ENV: "production",
      REGION_AWS: "us-east-1",
    });

    expect(typeof loadHandler().handler).toBe("function");
  });

  it("still refuses to start without NEXT_PUBLIC_ENV", () => {
    // The one variable the graph validates. Removing the other four must not
    // have removed this check with them.
    useOnly({ NODE_ENV: "production", DATABASE_URL });

    expect(loadHandler).toThrow(/NEXT_PUBLIC_ENV/);
  });

  it("refuses a NEXT_PUBLIC_ENV that is not a deployment", () => {
    useOnly({ NODE_ENV: "production", DATABASE_URL, NEXT_PUBLIC_ENV: "prod" });

    expect(loadHandler).toThrow(/NEXT_PUBLIC_ENV/);
  });
});

describe("the recipient filter in that environment", () => {
  const ADDRESSES = ["admin@gmail.com", "admin@northeastern.edu"];

  it("lets production mail every admin", () => {
    useOnly({
      NODE_ENV: "production",
      DATABASE_URL,
      NEXT_PUBLIC_ENV: "production",
    });
    loadHandler();

    expect(ADDRESSES.map(loadRecipientFilter())).toEqual([true, true]);
  });

  it("restricts staging to gmail.com", () => {
    useOnly({
      NODE_ENV: "production",
      DATABASE_URL,
      NEXT_PUBLIC_ENV: "staging",
    });
    loadHandler();

    expect(ADDRESSES.map(loadRecipientFilter())).toEqual([true, false]);
  });
});

describe("with NODE_ENV unset, as the Lambda runtime leaves it", () => {
  it("reads a missing NEXT_PUBLIC_ENV as development rather than refusing", () => {
    // Pinned so the behaviour is visible, not because it is wanted. envsafe
    // applies `devDefault` whenever NODE_ENV is not `production`, and nothing
    // in the Lambda sets it — so the refusal in the test above holds only
    // under `next build`. `template.yaml` always supplies NEXT_PUBLIC_ENV
    // from its `DeployEnv` parameter, whose allowed values have no empty
    // option, which is what stands between this and a staging stack mailing
    // every admin. Unchanged by SCRUM-739: `browserEnv` behaved the same way.
    // SCRUM-740 tracks making a missing value refuse; invert this when it lands.
    useOnly({ DATABASE_URL });

    loadHandler();
    expect(
      (
        require("../../src/utils/env/deployEnv") as typeof import("../../src/utils/env/deployEnv")
      ).deployEnv.NEXT_PUBLIC_ENV,
    ).toBe("development");
  });
});
