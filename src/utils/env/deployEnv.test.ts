import { readFileSync } from "fs";
import { join } from "path";

/**
 * `deployEnv` is a second validator for `NEXT_PUBLIC_ENV`, alongside
 * `browserEnv`'s. Two validators for one variable are only safe while they
 * agree, so this file checks the agreement directly instead of trusting two
 * option blocks to stay identical — a drift here would let the report-digest
 * Lambda read a deployment as "not staging" while the app read it as staging,
 * and the gmail-only recipient filter would quietly switch off.
 *
 * Each case re-requires both modules after `jest.resetModules()`, because
 * envsafe reads the environment once at import time. `jest.setup.env.js`
 * supplies the other four `NEXT_PUBLIC_*` variables `browserEnv` needs.
 */

const UNUSED_BY_DEPLOY_ENV = [
  "NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN",
  "NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN",
  "NEXT_PUBLIC_PUSHER_KEY",
  "NEXT_PUBLIC_PUSHER_CLUSTER",
] as const;

type Outcome = { value: string } | "throws";

let savedEnv: NodeJS.ProcessEnv;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  savedEnv = { ...process.env };
  jest.resetModules();
  // envsafe's default reporter logs the offending variable before throwing.
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env = savedEnv;
  errorSpy.mockRestore();
});

const setEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

/** What one module makes of `NEXT_PUBLIC_ENV`, loaded fresh. */
const outcomeOf = (load: () => string): Outcome => {
  jest.resetModules();
  try {
    return { value: load() };
  } catch {
    return "throws";
  }
};

describe("deployEnv agrees with browserEnv on NEXT_PUBLIC_ENV", () => {
  // One of each input class: every allowed value, the two spellings envsafe
  // treats as absent, and near-misses that must be refused rather than read
  // as "not staging".
  const inputs = [
    "production",
    "staging",
    "development",
    "",
    undefined,
    "prod",
    "Staging",
    " staging",
  ];

  // `test` is what Jest and a local run see; `production` is what `next
  // build` sets, where `devDefault` stops applying.
  describe.each(["test", "production"])("with NODE_ENV=%s", (nodeEnv) => {
    it.each(inputs.map((input) => [JSON.stringify(input), input]))(
      "for NEXT_PUBLIC_ENV=%s",
      (_label, input) => {
        setEnv("NODE_ENV", nodeEnv);
        setEnv("NEXT_PUBLIC_ENV", input);

        const viaBrowser = outcomeOf(
          () => require("./browser").browserEnv.NEXT_PUBLIC_ENV,
        );
        const viaDeploy = outcomeOf(
          () => require("./deployEnv").deployEnv.NEXT_PUBLIC_ENV,
        );

        expect(viaDeploy).toEqual(viaBrowser);
      },
    );
  });

  it("is not vacuous: the cases above include both a value and a refusal", () => {
    // Positive control for the table above. If both modules threw for every
    // input — a broken setup file, say — every comparison would pass.
    setEnv("NODE_ENV", "production");

    setEnv("NEXT_PUBLIC_ENV", "staging");
    expect(
      outcomeOf(() => require("./deployEnv").deployEnv.NEXT_PUBLIC_ENV),
    ).toEqual({ value: "staging" });

    setEnv("NEXT_PUBLIC_ENV", undefined);
    expect(
      outcomeOf(() => require("./deployEnv").deployEnv.NEXT_PUBLIC_ENV),
    ).toBe("throws");
  });
});

describe("deployEnv needs nothing but NEXT_PUBLIC_ENV", () => {
  it("loads with the other four NEXT_PUBLIC_* variables absent", () => {
    for (const name of UNUSED_BY_DEPLOY_ENV) {
      setEnv(name, undefined);
    }
    setEnv("NODE_ENV", "production");
    setEnv("NEXT_PUBLIC_ENV", "staging");

    expect(require("./deployEnv").deployEnv.NEXT_PUBLIC_ENV).toBe("staging");

    // Control: the same environment is one `browserEnv` refuses, so the line
    // above is a real difference rather than a setup that satisfies both.
    jest.resetModules();
    expect(() => require("./browser")).toThrow(/Missing environment/);
  });

  it("reads no environment variable that browser.ts does not", () => {
    // `scripts/check-env-contract.js` derives the whole environment contract
    // — `.env.example`, `amplify.yml`, CI's placeholders — from `browser.ts`
    // and `server.ts`. A variable read here and nowhere there would be
    // required at runtime and absent from every one of those.
    const reads = (file: string) =>
      new Set(
        [
          ...readFileSync(join(__dirname, file), "utf8").matchAll(
            /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
          ),
        ].map((match) => match[1]),
      );

    const deployReads = reads("deployEnv.ts");
    const browserReads = reads("browser.ts");

    expect([...deployReads]).toEqual(["NEXT_PUBLIC_ENV"]);
    for (const name of deployReads) {
      expect(browserReads).toContain(name);
    }

    // The shared definitions module must read nothing at all.
    expect([...reads("deployEnvValidator.ts")]).toEqual([]);
  });
});
