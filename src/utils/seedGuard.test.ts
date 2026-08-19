import {
  assertSeedTargetIsLocal,
  describeBlockedSeed,
  evaluateSeedTarget,
  isOverrideEnabled,
  normalizeHostname,
  SEED_OVERRIDE_ENV,
  SeedGuardError,
} from "./seedGuard";

// A realistic PlanetScale-shaped connection string. The password is fictional;
// the point of these tests is that the guard never reaches it.
const REMOTE_URL =
  "mysql://user:not-a-real-password@aws.connect.psdb.cloud/nucarpool?sslaccept=strict";
const LOCAL_URL = "mysql://root:password@localhost:3306/nucoop";

describe("normalizeHostname", () => {
  it("strips the brackets the URL parser puts around IPv6 literals", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
  });

  it("lowercases, since hostnames are case-insensitive", () => {
    expect(normalizeHostname("LOCALHOST")).toBe("localhost");
  });

  it("leaves an ordinary hostname alone", () => {
    expect(normalizeHostname("127.0.0.1")).toBe("127.0.0.1");
  });

  it("does not treat a lone bracket as an IPv6 literal", () => {
    expect(normalizeHostname("[")).toBe("[");
  });
});

describe("isOverrideEnabled", () => {
  it.each(["1", "true", "TRUE", " true "])(
    "treats %p as opting in",
    (value) => {
      expect(isOverrideEnabled(value)).toBe(true);
    },
  );

  it.each([undefined, "", "0", "false", "no", "yes", "please"])(
    "does not treat %p as opting in",
    (value) => {
      expect(isOverrideEnabled(value)).toBe(false);
    },
  );
});

describe("evaluateSeedTarget", () => {
  it.each([
    "mysql://root:password@localhost:3306/nucoop",
    "mysql://root:password@127.0.0.1:3306/nucoop",
    "mysql://root:password@[::1]:3306/nucoop",
    "mysql://root:password@0.0.0.0:3306/nucoop",
    "mysql://root:password@mysql:3306/nucoop",
    "mysql://root:password@mysql-on-docker:3306/nucoop",
    "mysql://root:password@LocalHost:3306/nucoop",
  ])("allows the local target %p", (url) => {
    expect(evaluateSeedTarget(url)).toEqual({
      allowed: true,
      hostname: expect.any(String),
      reason: "local-host",
    });
  });

  it("blocks a remote host", () => {
    expect(evaluateSeedTarget(REMOTE_URL)).toEqual({
      allowed: false,
      hostname: "aws.connect.psdb.cloud",
      reason: "remote-host",
    });
  });

  // The reason the guard compares hostname only, rather than searching the
  // connection string for "localhost".
  it("is not fooled by a credential that looks local", () => {
    expect(
      evaluateSeedTarget("mysql://localhost:pw@evil.example.com/db"),
    ).toEqual({
      allowed: false,
      hostname: "evil.example.com",
      reason: "remote-host",
    });
  });

  it("is not fooled by a query parameter that looks local", () => {
    expect(
      evaluateSeedTarget("mysql://u:p@evil.example.com/db?host=localhost"),
    ).toEqual({
      allowed: false,
      hostname: "evil.example.com",
      reason: "remote-host",
    });
  });

  it("is not fooled by a hostname that merely ends in an allowed name", () => {
    expect(evaluateSeedTarget("mysql://u:p@notlocalhost/db").allowed).toBe(
      false,
    );
    expect(
      evaluateSeedTarget("mysql://u:p@localhost.evil.example.com/db").allowed,
    ).toBe(false);
  });

  describe("failing closed", () => {
    it.each([undefined, "", "   "])(
      "blocks a missing DATABASE_URL (%p)",
      (url) => {
        expect(evaluateSeedTarget(url)).toEqual({
          allowed: false,
          hostname: null,
          reason: "missing-url",
        });
      },
    );

    it("blocks an unparseable DATABASE_URL", () => {
      expect(evaluateSeedTarget("not a url")).toEqual({
        allowed: false,
        hostname: null,
        reason: "unparseable-url",
      });
    });

    it("blocks a URL with no hostname", () => {
      expect(evaluateSeedTarget("mysql:///nucoop")).toEqual({
        allowed: false,
        hostname: null,
        reason: "empty-hostname",
      });
    });

    it("does not let the override authorise an unidentifiable target", () => {
      expect(evaluateSeedTarget(undefined, "1").allowed).toBe(false);
      expect(evaluateSeedTarget("not a url", "1").allowed).toBe(false);
    });
  });

  describe("the override", () => {
    it("permits a remote host when explicitly enabled", () => {
      expect(evaluateSeedTarget(REMOTE_URL, "1")).toEqual({
        allowed: true,
        hostname: "aws.connect.psdb.cloud",
        reason: "override",
      });
    });

    it("still blocks when set to a value that is not an opt-in", () => {
      expect(evaluateSeedTarget(REMOTE_URL, "0").allowed).toBe(false);
      expect(evaluateSeedTarget(REMOTE_URL, "false").allowed).toBe(false);
      expect(evaluateSeedTarget(REMOTE_URL, "").allowed).toBe(false);
    });

    it("is not needed for a local host, and is not reported for one", () => {
      expect(evaluateSeedTarget(LOCAL_URL, "1").reason).toBe("local-host");
    });
  });
});

describe("describeBlockedSeed", () => {
  it("names the refused host and how to override deliberately", () => {
    const message = describeBlockedSeed(evaluateSeedTarget(REMOTE_URL));
    expect(message).toContain("aws.connect.psdb.cloud");
    expect(message).toContain(SEED_OVERRIDE_ENV);
    expect(message).toContain("DELETES");
  });

  // The connection string holds credentials, so it must never be echoed.
  it("never leaks the password from the connection string", () => {
    const message = describeBlockedSeed(evaluateSeedTarget(REMOTE_URL));
    expect(message).not.toContain("not-a-real-password");
    expect(message).not.toContain(REMOTE_URL);
  });

  it("explains a missing DATABASE_URL without inventing a host", () => {
    const message = describeBlockedSeed(evaluateSeedTarget(undefined));
    expect(message).toContain("DATABASE_URL is not set");
    expect(message).not.toContain(SEED_OVERRIDE_ENV);
  });

  it("refuses to describe an allowed decision", () => {
    expect(() => describeBlockedSeed(evaluateSeedTarget(LOCAL_URL))).toThrow();
  });
});

describe("assertSeedTargetIsLocal", () => {
  it("returns the decision for a local target", () => {
    expect(assertSeedTargetIsLocal({ DATABASE_URL: LOCAL_URL })).toEqual({
      allowed: true,
      hostname: "localhost",
      reason: "local-host",
    });
  });

  it("throws SeedGuardError for a remote target, carrying the reason", () => {
    expect(() => assertSeedTargetIsLocal({ DATABASE_URL: REMOTE_URL })).toThrow(
      SeedGuardError,
    );
    try {
      assertSeedTargetIsLocal({ DATABASE_URL: REMOTE_URL });
      throw new Error("expected assertSeedTargetIsLocal to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SeedGuardError);
      expect((error as SeedGuardError).reason).toBe("remote-host");
    }
  });

  it("reads the override from the environment it is given", () => {
    expect(
      assertSeedTargetIsLocal({
        DATABASE_URL: REMOTE_URL,
        [SEED_OVERRIDE_ENV]: "1",
      }).reason,
    ).toBe("override");
  });

  it("throws when the environment has no DATABASE_URL at all", () => {
    expect(() => assertSeedTargetIsLocal({})).toThrow(SeedGuardError);
  });
});
