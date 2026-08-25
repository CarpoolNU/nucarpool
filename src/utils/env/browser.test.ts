/**
 * Validation of `NEXT_PUBLIC_ENV` (SCRUM-247).
 *
 * This was the only environment variable the app did not validate, and the most
 * consequential one: it selects the auth providers, and it is written verbatim
 * into every S3 profile-picture key. An unrecognised value used to sail through
 * and quietly mean "not staging" — or, unset, produce the literal object key
 * `profile-pictures/undefined/...`.
 *
 * envsafe reads the environment when the module is first imported, so each case
 * here resets the module registry and re-requires it. `jest.setup.env.js`
 * supplies the other required variables.
 */

const ENV_MODULE = "./browser";

/** Re-imports the env module with `NEXT_PUBLIC_ENV` set to `value`. */
const loadWith = (value: string | undefined, nodeEnv = "test") => {
  jest.resetModules();

  const previousNodeEnv = process.env.NODE_ENV;
  const previousValue = process.env.NEXT_PUBLIC_ENV;

  // NODE_ENV decides whether envsafe honours `devDefault`, which is the
  // difference between a local run and the production build.
  (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_ENV;
  } else {
    process.env.NEXT_PUBLIC_ENV = value;
  }

  try {
    return require(ENV_MODULE).browserEnv.NEXT_PUBLIC_ENV as string;
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV =
      previousNodeEnv;
    if (previousValue === undefined) {
      delete process.env.NEXT_PUBLIC_ENV;
    } else {
      process.env.NEXT_PUBLIC_ENV = previousValue;
    }
  }
};

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  // envsafe's default reporter logs the offending variable before throwing.
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("NEXT_PUBLIC_ENV is validated against an allow-list", () => {
  it.each(["production", "staging", "development"])("accepts %s", (value) => {
    expect(loadWith(value)).toBe(value);
  });

  it("rejects a value that is not a deployment", () => {
    // The failure this closes: any unrecognised string used to be accepted and
    // silently treated as "not staging".
    expect(() => loadWith("prod")).toThrow();
  });

  it("rejects a plausible typo of staging rather than disabling Google silently", () => {
    expect(() => loadWith("stagng")).toThrow();
  });

  it("rejects the generic CI placeholder", () => {
    // scripts/check-env-contract.js overrides the placeholder for this variable
    // precisely because the generic one does not pass. If that override is ever
    // dropped, the build job fails — this pins why it exists.
    expect(() => loadWith("ci-placeholder-not-a-real-secret")).toThrow();
  });
});

describe("NEXT_PUBLIC_ENV outside production", () => {
  it("falls back to development when unset, so a fresh clone starts", () => {
    expect(loadWith(undefined)).toBe("development");
  });

  it("treats the empty value .env.example ships as unset", () => {
    // envsafe's `allowEmpty` defaults to false, which is what makes the
    // committed `NEXT_PUBLIC_ENV=""` usable rather than a startup failure.
    expect(loadWith("")).toBe("development");
  });
});

describe("NEXT_PUBLIC_ENV in a production build", () => {
  it("requires an explicit value, because devDefault no longer applies", () => {
    // `next build` sets NODE_ENV=production, so a deploy that forgot the
    // variable fails the build instead of writing to
    // `profile-pictures/undefined/...` at runtime.
    expect(() => loadWith(undefined, "production")).toThrow();
  });

  it("accepts the value the deployed app uses", () => {
    expect(loadWith("production", "production")).toBe("production");
  });
});
