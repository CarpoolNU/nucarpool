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
 * Most cases set `NODE_ENV=production`, as `next build` does. The Lambda
 * runtime does not set `NODE_ENV` at all, so the last block repeats the cases
 * that matter with it unset — which is where `devDefault` used to supply a
 * missing `NEXT_PUBLIC_ENV` (SCRUM-740).
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
 *
 * **Not airtight locally.** Requiring `@prisma/client` loads the repository's
 * `.env` and fills in any variable still unset, so from that point on a local
 * run can see a `NEXT_PUBLIC_ENV` the test did not give it. CI has no `.env`.
 * The refusals below hold anyway, because `handler.ts` imports
 * `requireDeployEnv.ts` before Prisma; a new assertion about an unset variable
 * has to be made before the handler is required.
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
  it("refuses to start without NEXT_PUBLIC_ENV rather than reading it as development", () => {
    // envsafe applies `deployEnv.ts`'s `devDefault` whenever NODE_ENV is not
    // `production`, and nothing in the Lambda sets it. Before SCRUM-740 this
    // loaded as `development`, so a function configured without the variable
    // started with staging's gmail-only filter off. `requireDeployEnv.ts` now
    // refuses whatever NODE_ENV is.
    useOnly({ DATABASE_URL });

    expect(loadHandler).toThrow(
      /Missing environment variables[\s\S]*NEXT_PUBLIC_ENV/,
    );
  });

  it("refuses an empty NEXT_PUBLIC_ENV the same way", () => {
    // envsafe treats "" as unset, so a variable cleared to empty in the
    // console is the same exposure as one deleted.
    useOnly({ DATABASE_URL, NEXT_PUBLIC_ENV: "" });

    expect(loadHandler).toThrow(
      /Missing environment variables[\s\S]*NEXT_PUBLIC_ENV/,
    );
  });

  it("still loads, and staging still restricts to gmail.com", () => {
    // The positive control: the refusal above must come from the missing
    // value, not from NODE_ENV being unset.
    useOnly({ DATABASE_URL, NEXT_PUBLIC_ENV: "staging" });
    expect(typeof loadHandler().handler).toBe("function");

    expect(
      ["admin@gmail.com", "admin@northeastern.edu"].map(loadRecipientFilter()),
    ).toEqual([true, false]);
  });
});
