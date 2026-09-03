import {
  APP_DATABASE_URL_ENV,
  FORBIDDEN_NAME_SUBSTRINGS,
  TEST_DATABASE_URL_ENV,
  TestDatabaseGuardError,
  assertTestDatabaseTarget,
  describeBlockedTestDatabase,
  evaluateTestDatabaseTarget,
  forbiddenSubstringIn,
  isMarkedAsTest,
  type TestDatabaseBlockReason,
} from "./testDatabaseGuard";

/**
 * The guard is the one part of the integration harness whose failure is
 * measured in somebody else's rows, so this suite is written as an attempt to
 * get past it rather than as a demonstration that it works.
 *
 * Every case is a target the harness must refuse, or the small set it must
 * accept. Nothing here needs a database — that is the whole reason the rules
 * live in a pure module.
 */

/** A password that must never reach any output the guard produces. */
const SECRET = "pw-must-not-appear";

/**
 * A username, checked separately. Distinctive rather than `root` because the
 * refusal text legitimately contains an example connection string, and an
 * assertion on a common word would flag that documentation as a leak.
 */
const USERNAME = "user-must-not-appear";

const reasonFor = (url: string | undefined, appUrl?: string) => {
  const decision = evaluateTestDatabaseTarget(url, appUrl);
  return decision.allowed ? "allowed" : decision.reason;
};

describe("the target the guard exists to allow", () => {
  it.each([
    [
      "the documented local form",
      "mysql://root:pw@127.0.0.1:3306/nucarpool_test",
    ],
    ["localhost by name", "mysql://root:pw@localhost:3306/nucarpool_test"],
    // `mysql:` is not a *special* scheme, so Node does not lowercase its host
    // the way it would for `http:`. `normalizeHostname` is what makes this
    // pass, and this case is why it cannot be dropped.
    ["an upper-case hostname", "mysql://root:pw@LOCALHOST:3306/nucarpool_test"],
    ["a bracketed IPv6 loopback", "mysql://root:pw@[::1]:3306/nucarpool_test"],
    [
      "the Compose container name",
      "mysql://root:pw@mysql-on-docker:3306/nucarpool_test",
    ],
    [
      "a percent-encoded underscore",
      "mysql://root:pw@localhost/nucarpool%5Ftest",
    ],
    [
      "connection parameters",
      "mysql://root:pw@localhost/nucarpool_test?connection_limit=5",
    ],
    [
      "a per-worker database name",
      "mysql://root:pw@localhost/nucarpool_test_3",
    ],
    ["a hyphenated name", "mysql://root:pw@localhost/ci-test"],
    ["an upper-case name", "mysql://root:pw@localhost/TEST"],
  ])("allows %s", (_label, url) => {
    expect(evaluateTestDatabaseTarget(url)).toMatchObject({ allowed: true });
  });

  it("reports the hostname and database name it approved", () => {
    expect(
      evaluateTestDatabaseTarget(
        `mysql://root:${SECRET}@127.0.0.1:3306/nucarpool_test`,
      ),
    ).toEqual({
      allowed: true,
      hostname: "127.0.0.1",
      databaseName: "nucarpool_test",
    });
  });

  it("accepts the CI shape, where DATABASE_URL is a placeholder on the same host", () => {
    // build.yml's placeholder is mysql://ci:ci@127.0.0.1:3306/ci - same host
    // and port as the service container, different database. That has to be
    // allowed or the CI job could never run.
    expect(
      reasonFor(
        "mysql://root:test@127.0.0.1:3306/nucarpool_test",
        "mysql://ci:ci@127.0.0.1:3306/ci",
      ),
    ).toBe("allowed");
  });
});

describe("a missing or malformed value", () => {
  it.each([
    ["undefined", undefined, "missing-url"],
    ["empty", "", "missing-url"],
    ["whitespace only", "   ", "missing-url"],
    ["not a URL at all", "not a url", "unparseable-url"],
    [
      "an out-of-range port",
      "mysql://localhost:99999/nucarpool_test",
      "unparseable-url",
    ],
    ["a bare database name", "nucarpool_test", "unparseable-url"],
    ["a scheme-relative form", "//localhost/nucarpool_test", "unparseable-url"],
    ["postgres", "postgres://localhost/nucarpool_test", "wrong-protocol"],
    ["https", "https://localhost/nucarpool_test", "wrong-protocol"],
    ["file", "file:///tmp/nucarpool_test", "wrong-protocol"],
    ["no host", "mysql:///nucarpool_test", "empty-hostname"],
    // The opaque `mysql:name` form has no host, so it is refused on the host
    // rule before its path is ever read.
    ["the opaque scheme form", "mysql:nucarpool_test", "empty-hostname"],
    ["no database", "mysql://localhost", "missing-database-name"],
    ["a bare trailing slash", "mysql://localhost/", "missing-database-name"],
  ] as [string, string | undefined, TestDatabaseBlockReason][])(
    "refuses %s",
    (_label, url, reason) => {
      expect(reasonFor(url)).toBe(reason);
    },
  );
});

describe("a non-local host", () => {
  it.each([
    [
      "PlanetScale, with a test-looking database",
      "mysql://user:pw@aws.connect.psdb.cloud/nucarpool_test",
    ],
    [
      "PlanetScale, with the real database",
      "mysql://user:pw@aws.connect.psdb.cloud/nucarpool",
    ],
    [
      "an arbitrary remote host",
      "mysql://user:pw@db.example.com:3306/nucarpool_test",
    ],
    [
      "a subdomain that merely starts with localhost",
      "mysql://localhost.example.com/nucarpool_test",
    ],
    // The WHATWG parser reads this as the host `evil.example.com`, so a
    // hostname in the credentials cannot fake a match - the property
    // seedGuard.ts documents, re-checked here because this guard shares its
    // allowlist.
    [
      "a local-looking username",
      "mysql://localhost:pw@evil.example.com/nucarpool_test",
    ],
    [
      "a local-looking password",
      "mysql://root:127.0.0.1@evil.example.com/nucarpool_test",
    ],
  ])("refuses %s", (_label, url) => {
    expect(reasonFor(url)).toBe("remote-host");
  });

  it("refuses a fully qualified loopback written with a trailing dot", () => {
    // `localhost.` genuinely resolves to the loopback, so this is a
    // false negative - the guard refuses something harmless. That is the safe
    // direction and it is deliberate: the allowlist is compared literally
    // rather than resolved, because resolution is a network answer that can
    // change under the same string.
    expect(reasonFor("mysql://localhost./nucarpool_test")).toBe("remote-host");
    expect(reasonFor("mysql://127.0.0.1./nucarpool_test")).toBe("remote-host");
  });

  it("names the host it refused, and nothing else about the URL", () => {
    const decision = evaluateTestDatabaseTarget(
      `mysql://root:${SECRET}@aws.connect.psdb.cloud/nucarpool_test`,
    );

    expect(decision).toEqual({
      allowed: false,
      hostname: "aws.connect.psdb.cloud",
      databaseName: null,
      reason: "remote-host",
    });
  });
});

describe("a local host, but not a test database", () => {
  it.each([
    ["localhost", "mysql://root:pw@localhost:3306/nucarpool"],
    ["127.0.0.1", "mysql://root:pw@127.0.0.1:3306/nucarpool"],
    ["::1", "mysql://root:pw@[::1]:3306/nucarpool"],
    ["0.0.0.0", "mysql://root:pw@0.0.0.0:3306/nucarpool"],
    ["the Compose service name", "mysql://root:pw@mysql:3306/nucarpool"],
  ])("refuses the developer's own database on %s", (_label, url) => {
    expect(reasonFor(url)).toBe("name-not-marked-test");
  });

  it.each([
    // `test` is a substring of all three, and a substring rule would have
    // accepted every one of them.
    ["latest", "mysql://localhost/nucarpool_latest"],
    ["greatest", "mysql://localhost/greatest"],
    ["attestation", "mysql://localhost/attestation_db"],
    ["contest", "mysql://localhost/contest"],
  ])("refuses %s, which merely contains the word", (_label, url) => {
    expect(reasonFor(url)).toBe("name-not-marked-test");
  });

  it("refuses a name with no delimiter to make the word out of", () => {
    // Another deliberate false negative: `nucarpooltest` reads as a test
    // database to a human but has no `test` word, and loosening the rule to
    // catch it is what re-admits `latest`.
    expect(reasonFor("mysql://localhost/nucarpooltest")).toBe(
      "name-not-marked-test",
    );
  });
});

describe("names that look like a real environment", () => {
  it.each([
    ["production", "mysql://localhost/nucarpool_production"],
    ["prod", "mysql://localhost/prod"],
    ["staging", "mysql://localhost/nucarpool_staging"],
    ["stage", "mysql://localhost/stage"],
    ["main", "mysql://localhost/main"],
    ["live", "mysql://localhost/nucarpool_live"],
  ])("refuses %s", (_label, url) => {
    expect(reasonFor(url)).toBe("forbidden-database-name");
  });

  it.each([
    ["staging_test", "mysql://localhost/staging_test"],
    ["test_production", "mysql://localhost/test_production"],
    ["prod-test", "mysql://localhost/prod-test"],
    ["nucarpool_live_test", "mysql://localhost/nucarpool_live_test"],
    ["main_test", "mysql://localhost/main_test"],
  ])("refuses %s even though it carries a test word", (_label, url) => {
    // Refusing is broad and allowing is strict, so the forbidden list wins.
    // Without this, naming a real database `..._test` would open it up.
    expect(reasonFor(url)).toBe("forbidden-database-name");
  });

  it("refuses a real environment reached through the query string", () => {
    // The database is the path, never the query - so `?db=test` decorates
    // nothing and the name is still `prod`.
    expect(reasonFor("mysql://localhost/prod?db=test")).toBe(
      "forbidden-database-name",
    );
  });
});

describe("encoded and unusual URL forms", () => {
  it("refuses a percent-encoded production name that a raw-path rule would accept", () => {
    // The bypass this rule exists for. `/%70roduction_test` contains neither
    // `prod` nor anything else disqualifying as written, and it carries the
    // word `test`, so a guard reading the raw path allows it - and the driver
    // then decodes it and connects to `production_test`.
    expect(reasonFor("mysql://localhost/%70roduction_test")).toBe(
      "forbidden-database-name",
    );
    expect(reasonFor("mysql://localhost/nucarpool_%73taging_test")).toBe(
      "forbidden-database-name",
    );
  });

  it.each([
    ["an encoded slash", "mysql://localhost/nucarpool%2Ftest"],
    ["a trailing slash", "mysql://localhost/nucarpool_test/"],
    ["a nested path", "mysql://localhost/nucarpool_test/extra"],
    ["a space", "mysql://localhost/nucarpool test"],
    ["a dot", "mysql://localhost/nucarpool.test"],
    ["a backtick", "mysql://localhost/nucarpool%60test"],
    ["a semicolon", "mysql://localhost/nucarpool_test%3B"],
    ["a double-encoded prefix", "mysql://localhost/%2570roduction_test"],
  ])("refuses %s", (_label, url) => {
    // Decoded once, then required to be a plain identifier. That charset check
    // is what retires this whole class without reasoning about each escape:
    // `%2570` decodes once to `%70`, which is still not an identifier
    // character, so the double-encoded form is refused rather than
    // re-examined.
    expect(reasonFor(url)).toBe("unsafe-database-name");
  });

  it("refuses malformed percent-encoding rather than throwing", () => {
    expect(reasonFor("mysql://localhost/nucarpool%ZZtest")).toBe(
      "undecodable-database-name",
    );
    expect(reasonFor("mysql://localhost/nucarpool%")).toBe(
      "undecodable-database-name",
    );
  });

  it("tolerates surrounding whitespace rather than reading it as a name", () => {
    expect(reasonFor("  mysql://localhost/nucarpool_test  ")).toBe("allowed");
  });
});

describe("sharing with DATABASE_URL", () => {
  const testUrl = "mysql://root:pw@127.0.0.1:3306/nucarpool_test";

  it("refuses the same string in both variables", () => {
    expect(reasonFor(testUrl, testUrl)).toBe("shared-with-app-url");
  });

  it("refuses the same string when only whitespace differs", () => {
    expect(reasonFor(`  ${testUrl}`, `${testUrl}  `)).toBe(
      "shared-with-app-url",
    );
  });

  it("refuses a different connection string addressing the same database", () => {
    // The hazard is the database, not the spelling: different credentials to
    // the same rows would truncate whatever the app is using.
    expect(
      reasonFor(testUrl, "mysql://someone:else@127.0.0.1:3306/nucarpool_test"),
    ).toBe("same-database-as-app");
  });

  it("treats an omitted port as 3306 on both sides", () => {
    expect(
      reasonFor(
        "mysql://root:pw@127.0.0.1/nucarpool_test",
        "mysql://root:pw@127.0.0.1:3306/nucarpool_test",
      ),
    ).toBe("same-database-as-app");
  });

  it("allows a different database on the same host and port", () => {
    expect(reasonFor(testUrl, "mysql://root:pw@127.0.0.1:3306/nucarpool")).toBe(
      "allowed",
    );
  });

  it("allows a different port on the same host", () => {
    expect(
      reasonFor(testUrl, "mysql://root:pw@127.0.0.1:3307/nucarpool_test"),
    ).toBe("allowed");
  });

  it("does not treat an unusable DATABASE_URL as a match", () => {
    // Nothing to compare against is not the same as matching, and the eleven
    // rules before it still had to pass.
    expect(reasonFor(testUrl, "not a url")).toBe("allowed");
    expect(reasonFor(testUrl, "")).toBe("allowed");
    expect(reasonFor(testUrl, undefined)).toBe("allowed");
  });
});

describe("no hostile target is ever allowed", () => {
  /**
   * Stated as one sweep so that a future rule change cannot quietly open one
   * of these up: whatever the reasons become, none of these may end in
   * `allowed`.
   */
  const mustBeRefused = [
    undefined,
    "",
    "   ",
    "not a url",
    "nucarpool_test",
    "mysql:nucarpool_test",
    "mysql:///nucarpool_test",
    "mysql://localhost",
    "mysql://localhost/",
    "postgres://localhost/nucarpool_test",
    "https://localhost/nucarpool_test",
    "mysql://localhost/nucarpool",
    "mysql://127.0.0.1:3306/nucarpool",
    "mysql://[::1]/nucarpool",
    "mysql://localhost/nucarpool_latest",
    "mysql://localhost/nucarpooltest",
    "mysql://localhost/prod",
    "mysql://localhost/nucarpool_production",
    "mysql://localhost/nucarpool_staging",
    "mysql://localhost/staging_test",
    "mysql://localhost/test_production",
    "mysql://localhost/main_test",
    "mysql://localhost/%70roduction_test",
    "mysql://localhost/nucarpool%2Ftest",
    "mysql://localhost/nucarpool%ZZtest",
    "mysql://localhost/nucarpool_test/",
    "mysql://aws.connect.psdb.cloud/nucarpool_test",
    "mysql://localhost:pw@evil.example.com/nucarpool_test",
    "mysql://db.example.com/nucarpool_test",
    "mysql://localhost./nucarpool_test",
  ];

  it.each(mustBeRefused)("refuses %p", (url) => {
    expect(evaluateTestDatabaseTarget(url)).toMatchObject({ allowed: false });
  });

  it("refuses all of them under every DATABASE_URL it might be paired with", () => {
    const appUrls = [
      undefined,
      "",
      "not a url",
      "mysql://ci:ci@127.0.0.1:3306/ci",
      "mysql://root:pw@127.0.0.1:3306/nucarpool",
    ];

    for (const appUrl of appUrls) {
      for (const url of mustBeRefused) {
        expect(evaluateTestDatabaseTarget(url, appUrl).allowed).toBe(false);
      }
    }
  });
});

describe("describeBlockedTestDatabase", () => {
  const refusedUrls = [
    `mysql://${USERNAME}:${SECRET}@aws.connect.psdb.cloud/nucarpool`,
    `mysql://${USERNAME}:${SECRET}@localhost/nucarpool`,
    `mysql://${USERNAME}:${SECRET}@localhost/nucarpool_production`,
    `mysql://${USERNAME}:${SECRET}@localhost/nucarpool%2Ftest`,
    `mysql://${USERNAME}:${SECRET}@localhost/nucarpool%ZZtest`,
    `mysql://${USERNAME}:${SECRET}@localhost`,
    `mysql://${USERNAME}:${SECRET}@localhost:99999/nucarpool_test`,
    `postgres://${USERNAME}:${SECRET}@localhost/nucarpool_test`,
  ];

  it.each(refusedUrls)("never prints the credentials in %p", (url) => {
    // Evaluated with no DATABASE_URL so each of these is refused for its own
    // reason. Pairing it with itself would short-circuit every case to
    // `shared-with-app-url` and test one message eight times.
    const decision = evaluateTestDatabaseTarget(url);
    expect(decision.allowed).toBe(false);

    const message = describeBlockedTestDatabase(decision);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(USERNAME);
    expect(message).not.toContain(url);

    // And the same through the thrown error, which is what an operator
    // actually sees.
    const error = new TestDatabaseGuardError(
      decision as Extract<typeof decision, { allowed: false }>,
    );
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(url);
  });

  it("never prints the credentials when both variables hold the same secret", () => {
    const url = `mysql://${USERNAME}:${SECRET}@127.0.0.1:3306/nucarpool_test`;
    const decision = evaluateTestDatabaseTarget(url, url);

    expect(decision).toMatchObject({ reason: "shared-with-app-url" });
    const message = describeBlockedTestDatabase(decision);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain(USERNAME);
  });

  it("explains every reason, with no unfilled placeholder", () => {
    const oneUrlPerReason: Record<
      TestDatabaseBlockReason,
      [string | undefined, string?]
    > = {
      "missing-url": [undefined],
      "shared-with-app-url": [
        "mysql://localhost/nucarpool_test",
        "mysql://localhost/nucarpool_test",
      ],
      "unparseable-url": ["not a url"],
      "wrong-protocol": ["postgres://localhost/nucarpool_test"],
      "empty-hostname": ["mysql:///nucarpool_test"],
      "remote-host": ["mysql://aws.connect.psdb.cloud/nucarpool_test"],
      "missing-database-name": ["mysql://localhost"],
      "undecodable-database-name": ["mysql://localhost/nucarpool%ZZtest"],
      "unsafe-database-name": ["mysql://localhost/nucarpool%2Ftest"],
      "forbidden-database-name": ["mysql://localhost/nucarpool_production"],
      "name-not-marked-test": ["mysql://localhost/nucarpool"],
      "same-database-as-app": [
        "mysql://a:b@127.0.0.1/nucarpool_test",
        "mysql://c:d@127.0.0.1:3306/nucarpool_test",
      ],
    };

    for (const [reason, [url, appUrl]] of Object.entries(oneUrlPerReason) as [
      TestDatabaseBlockReason,
      [string | undefined, string?],
    ][]) {
      const decision = evaluateTestDatabaseTarget(url, appUrl);
      expect(decision).toMatchObject({ allowed: false, reason });

      const message = describeBlockedTestDatabase(decision);
      expect(message).toContain("Refusing to run the integration test suite.");
      expect(message).not.toContain("undefined");
      expect(message).not.toContain("null");
      expect(message.length).toBeGreaterThan(80);
    }
  });

  it("refuses to explain an allowed decision", () => {
    const decision = evaluateTestDatabaseTarget(
      "mysql://localhost/nucarpool_test",
    );
    expect(() => describeBlockedTestDatabase(decision)).toThrow(
      /allowed decision/,
    );
  });

  it("offers no override, because there is none", () => {
    const decision = evaluateTestDatabaseTarget(
      "mysql://aws.connect.psdb.cloud/nucarpool_test",
    );
    const message = describeBlockedTestDatabase(decision);

    expect(message).toContain("There is no override");
    expect(message).not.toMatch(/ALLOW|FORCE|SKIP|=1/);
  });
});

describe("assertTestDatabaseTarget", () => {
  const local = "mysql://root:pw@127.0.0.1:3306/nucarpool_test";

  it("returns the approved host and database", () => {
    expect(
      assertTestDatabaseTarget({
        [TEST_DATABASE_URL_ENV]: local,
        [APP_DATABASE_URL_ENV]: "mysql://ci:ci@127.0.0.1:3306/ci",
      }),
    ).toEqual({
      allowed: true,
      hostname: "127.0.0.1",
      databaseName: "nucarpool_test",
    });
  });

  it("throws a reasoned error rather than a bare one", () => {
    let thrown: unknown;
    try {
      assertTestDatabaseTarget({
        [TEST_DATABASE_URL_ENV]: "mysql://aws.connect.psdb.cloud/nucarpool",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TestDatabaseGuardError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as TestDatabaseGuardError).reason).toBe("remote-host");
  });

  it("throws when nothing is configured at all", () => {
    expect(() => assertTestDatabaseTarget({})).toThrow(TestDatabaseGuardError);
  });

  it("reads only the two variables it is documented to read", () => {
    // A DATABASE_URL pointing anywhere must not become the target by default:
    // the harness never falls back to it.
    expect(() =>
      assertTestDatabaseTarget({
        [APP_DATABASE_URL_ENV]: local,
      }),
    ).toThrow(/is not set/);
  });

  it("does not let DATABASE_URL smuggle the target in", () => {
    expect(() =>
      assertTestDatabaseTarget({
        [TEST_DATABASE_URL_ENV]: "mysql://localhost/nucarpool",
        [APP_DATABASE_URL_ENV]: local,
      }),
    ).toThrow(TestDatabaseGuardError);
  });
});

describe("the word and substring helpers", () => {
  it.each([
    "test",
    "nucarpool_test",
    "test_nucarpool",
    "ci-test",
    "a_test_b",
    "TEST",
  ])("treats %p as marked", (name) => {
    expect(isMarkedAsTest(name)).toBe(true);
  });

  it.each([
    "nucarpool",
    "latest",
    "greatest",
    "nucarpooltest",
    "testing",
    "tests",
  ])("treats %p as unmarked", (name) => {
    expect(isMarkedAsTest(name)).toBe(false);
  });

  it("finds a forbidden stem wherever it sits", () => {
    expect(forbiddenSubstringIn("nucarpool_production")).toBe("prod");
    expect(forbiddenSubstringIn("staging")).toBe("stag");
    expect(forbiddenSubstringIn("stage")).toBe("stag");
    expect(forbiddenSubstringIn("NUCARPOOL_MAIN")).toBe("main");
    expect(forbiddenSubstringIn("nucarpool_test")).toBeNull();
  });

  it("uses stems that cover both spellings, which is why they are stems", () => {
    // `staging` does not contain `stage`, so a list of whole words would need
    // both. Asserted so a future tidy-up cannot replace the stem with the
    // longer word and silently stop matching.
    expect("staging").not.toContain("stage");
    expect(FORBIDDEN_NAME_SUBSTRINGS).toContain("stag");
    expect(FORBIDDEN_NAME_SUBSTRINGS).toContain("prod");
  });
});
