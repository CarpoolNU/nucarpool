import {
  INSTITUTIONAL_EMAIL_DOMAINS,
  STAGING_GUEST_EMAIL_DOMAINS,
  emailDomain,
  isSignInAllowed,
} from "./authSignIn";
import type { SignInAttempt } from "./authSignIn";

/**
 * The staging sign-in gate.
 *
 * These cases are the reason SCRUM-344 exists: before this module there was no
 * `signIn` callback anywhere, so every assertion below described behaviour the
 * app did not have. The two that matter most are "a Google account on an
 * unlisted domain is refused in staging" and "Azure AD is unaffected" — the
 * second because production sign-in must not be breakable by this change.
 *
 * `DeployEnv` is imported as a type only by the module under test, so no
 * environment variable is read and `envsafe` never runs here.
 */

const attempt = (over: Partial<SignInAttempt> = {}): SignInAttempt => ({
  provider: "google",
  email: "someone@northeastern.edu",
  env: "staging",
  ...over,
});

describe("emailDomain", () => {
  it("returns the lower-cased domain", () => {
    expect(emailDomain("Someone@Northeastern.EDU")).toBe("northeastern.edu");
  });

  it("splits on the last @, so a quoted local part does not confuse it", () => {
    // `"a@b"@northeastern.edu` is a single address at northeastern.edu.
    // Splitting on the first @ would read the domain as `b"@northeastern.edu`.
    expect(emailDomain('"a@b"@northeastern.edu')).toBe("northeastern.edu");
  });

  it("returns null when there is no domain to read", () => {
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain("trailing@")).toBeNull();
    expect(emailDomain("@leading.example")).toBe("leading.example");
    expect(emailDomain("spaces@   ")).toBeNull();
  });
});

describe("isSignInAllowed", () => {
  describe("providers other than Google are untouched", () => {
    it.each([
      ["azure-ad", "azure-ad"],
      ["an unrecognised provider", "some-future-provider"],
      ["no provider at all", undefined],
    ])("allows %s regardless of environment or address", (_label, provider) => {
      // Azure AD's tenant already decides who may authenticate, and refusing an
      // unknown provider would read as an outage rather than a policy.
      expect(
        isSignInAllowed(
          attempt({ provider, email: "anyone@example.com", env: "production" }),
        ),
      ).toBe(true);
    });

    it("allows Azure AD even when it supplies no email address", () => {
      // The gate must not depend on an address for the production path, because
      // a provider returning none would otherwise lock everyone out.
      expect(
        isSignInAllowed(
          attempt({ provider: "azure-ad", email: null, env: "staging" }),
        ),
      ).toBe(true);
    });
  });

  describe("Google outside staging", () => {
    // The provider is only constructed when NEXT_PUBLIC_ENV is `staging`, so
    // arriving here anywhere else means the provider list and this gate
    // disagree. browser.ts calls out exactly this hazard; fail closed.
    it.each(["production", "development"] as const)(
      "refuses Google in %s even on an institutional domain",
      (env) => {
        expect(
          isSignInAllowed(attempt({ email: "someone@northeastern.edu", env })),
        ).toBe(false);
      },
    );
  });

  describe("Google in staging", () => {
    it.each([...INSTITUTIONAL_EMAIL_DOMAINS])(
      "allows the institutional domain %s",
      (domain) => {
        expect(isSignInAllowed(attempt({ email: `someone@${domain}` }))).toBe(
          true,
        );
      },
    );

    it.each([...STAGING_GUEST_EMAIL_DOMAINS])(
      "allows the guest domain %s, which the real testers use",
      (domain) => {
        expect(isSignInAllowed(attempt({ email: `tester@${domain}` }))).toBe(
          true,
        );
      },
    );

    it("is case-insensitive about the domain", () => {
      expect(
        isSignInAllowed(attempt({ email: "Someone@NORTHEASTERN.EDU" })),
      ).toBe(true);
    });

    it.each([
      "someone@example.com",
      "someone@outlook.com",
      "someone@neu.edu",
      "someone@northeastern.edu.example.com",
      "someone@notnortheastern.edu",
    ])("refuses %s", (email) => {
      expect(isSignInAllowed(attempt({ email }))).toBe(false);
    });

    it("matches the domain exactly rather than by suffix", () => {
      // The bug this pins: `endsWith("northeastern.edu")` would accept an
      // attacker-registered `northeastern.edu.example.com`.
      expect(
        isSignInAllowed(
          attempt({ email: "someone@northeastern.edu.example.com" }),
        ),
      ).toBe(false);
    });

    it("does not let a listed domain in the local part get through", () => {
      // Splitting on the last @ is what makes this refuse: the domain is
      // `example.com`, not the `northeastern.edu` sitting in the local part.
      expect(
        isSignInAllowed(
          attempt({ email: "someone@northeastern.edu@example.com" }),
        ),
      ).toBe(false);
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty", ""],
      ["no domain", "no-at-sign"],
    ])("refuses a Google sign-in with a %s email", (_label, email) => {
      expect(isSignInAllowed(attempt({ email }))).toBe(false);
    });
  });

  describe("the guest list", () => {
    it("agrees with the staging email restriction in email.ts", () => {
      // `assertDeliverable` refuses to send staging mail anywhere but
      // gmail.com. A tester allowed to sign in on a domain that cannot receive
      // notifications would be a half-working account, so the two lists have to
      // stay in step. Pinned as a literal rather than by importing email.ts,
      // which would pull in the whole tRPC context.
      expect(STAGING_GUEST_EMAIL_DOMAINS).toContain("gmail.com");
    });
  });
});
