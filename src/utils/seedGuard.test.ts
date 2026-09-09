import {
  assertSeedTargetIsLocal,
  describeBlockedSeed,
  evaluateSeedTarget,
  normalizeHostname,
  SeedGuardError,
} from "./seedGuard";

// Realistic PlanetScale-shaped connection strings. The passwords are fictional;
// the point of these tests is that the guard never reaches them.
//
// Both branches are named explicitly rather than left to a generic "remote"
// case. They are the two hosts this guard exists to refuse, and a test that
// says so by name is the one a reader checks for (SCRUM-410).
const REMOTE_URL =
  "mysql://user:not-a-real-password@aws.connect.psdb.cloud/nucarpool?sslaccept=strict";
const PLANETSCALE_MAIN_URL =
  "mysql://main-user:not-a-real-password@aws.connect.psdb.cloud/nucarpool?sslaccept=strict";
const PLANETSCALE_STAGING_URL =
  "mysql://staging-user:not-a-real-password@aws.connect.psdb.cloud/nucarpool-staging?sslaccept=strict";
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
  });

  /**
   * SCRUM-410 removed `SEED_ALLOW_REMOTE`, which turned the refusal below off
   * for any host — production included. These pin that no argument brings it
   * back: `evaluateSeedTarget` now takes one parameter, and the only route to
   * `allowed: true` is membership of `LOCAL_HOSTNAMES`.
   */
  describe("the two hosts this exists to refuse", () => {
    it("blocks PlanetScale main", () => {
      expect(evaluateSeedTarget(PLANETSCALE_MAIN_URL)).toEqual({
        allowed: false,
        hostname: "aws.connect.psdb.cloud",
        reason: "remote-host",
      });
    });

    it("blocks PlanetScale staging", () => {
      expect(evaluateSeedTarget(PLANETSCALE_STAGING_URL)).toEqual({
        allowed: false,
        hostname: "aws.connect.psdb.cloud",
        reason: "remote-host",
      });
    });

    it("blocks an arbitrary remote host", () => {
      expect(
        evaluateSeedTarget("mysql://u:p@db.internal.example.com:3306/app")
          .allowed,
      ).toBe(false);
    });

    it("has no second argument that could permit one", () => {
      // A stale caller passing the old override value must not compile, and if
      // it somehow reaches here at runtime it must change nothing.
      const call = evaluateSeedTarget as (
        url: string | undefined,
        legacyOverride?: string,
      ) => ReturnType<typeof evaluateSeedTarget>;

      for (const value of ["1", "true", "TRUE", " true "]) {
        expect(call(PLANETSCALE_MAIN_URL, value).allowed).toBe(false);
      }
    });
  });
});

describe("describeBlockedSeed", () => {
  it("names the refused host and what would have been destroyed", () => {
    const message = describeBlockedSeed(evaluateSeedTarget(REMOTE_URL));
    expect(message).toContain("aws.connect.psdb.cloud");
    expect(message).toContain("DELETES");
  });

  it("offers no way to proceed against the refused host", () => {
    // The message used to end with `SEED_ALLOW_REMOTE=1 yarn seed`. Advertising
    // an escape hatch in the refusal is how one gets used; there is no longer
    // one to advertise, and the text must not imply otherwise.
    const message = describeBlockedSeed(evaluateSeedTarget(REMOTE_URL));
    expect(message).not.toContain("SEED_ALLOW_REMOTE");
    expect(message).toContain("There is no override");
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
    expect(message).not.toContain("SEED_ALLOW_REMOTE");
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

  it("ignores the removed override variable in the environment", () => {
    // A developer's shell, a .env, or a stale CI job may still carry it. It
    // must be inert rather than authoritative.
    expect(() =>
      assertSeedTargetIsLocal({
        DATABASE_URL: PLANETSCALE_MAIN_URL,
        SEED_ALLOW_REMOTE: "1",
      }),
    ).toThrow(SeedGuardError);
  });

  it("throws when the environment has no DATABASE_URL at all", () => {
    expect(() => assertSeedTargetIsLocal({})).toThrow(SeedGuardError);
  });
});
