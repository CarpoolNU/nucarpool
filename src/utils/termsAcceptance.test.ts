/**
 * The gate condition, and the separation the whole ticket turns on: a terms
 * version is a *record*, and re-consent is a *policy*. Bumping the first must
 * not silently do the second. SCRUM-280.
 *
 * The case that matters most is the legacy cohort - `licenseSigned` true with
 * a null version, which is every one of the ~3,341 production rows that
 * accepted before these columns existed. With the policy off they must not be
 * re-prompted, because adding a column is not a reason to put a blocking modal
 * in front of thousands of people. With it on they must be, because an unknown
 * wording is exactly who a re-consent is for.
 */

import {
  CURRENT_TERMS_VERSION,
  TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE,
  hasAcceptedCurrentTerms,
  needsTermsAcceptance,
} from "./termsAcceptance";

const STALE_VERSION = "2024-10-20";

describe("CURRENT_TERMS_VERSION", () => {
  it("is a plain calendar date, so an audit row can be read without a lookup", () => {
    expect(CURRENT_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("fits the column it is stored in", () => {
    // `license_version` is VARCHAR(32). A value longer than that is silently
    // truncated by MySQL in non-strict mode, which would corrupt the record
    // rather than fail the write.
    expect(CURRENT_TERMS_VERSION.length).toBeLessThanOrEqual(32);
  });
});

describe("hasAcceptedCurrentTerms", () => {
  it("is true only for an acceptance stamped with the current version", () => {
    expect(
      hasAcceptedCurrentTerms({
        licenseSigned: true,
        licenseVersion: CURRENT_TERMS_VERSION,
      }),
    ).toBe(true);
  });

  it("is false for the legacy cohort, however long ago they agreed", () => {
    expect(
      hasAcceptedCurrentTerms({ licenseSigned: true, licenseVersion: null }),
    ).toBe(false);
  });

  it("is false for an acceptance of superseded wording", () => {
    expect(
      hasAcceptedCurrentTerms({
        licenseSigned: true,
        licenseVersion: STALE_VERSION,
      }),
    ).toBe(false);
  });

  it("is false when nothing was ever accepted, whatever the version says", () => {
    // A version without the boolean is not a state the writer can produce.
    // Pinned so the boolean stays the thing that means "agreed".
    expect(
      hasAcceptedCurrentTerms({
        licenseSigned: false,
        licenseVersion: CURRENT_TERMS_VERSION,
      }),
    ).toBe(false);
  });
});

describe("needsTermsAcceptance", () => {
  it("defaults to the shipped policy, which is not to force re-consent", () => {
    // Guards the default itself. If this flips, every existing user meets a
    // blocking modal on their next page load - a university decision, not one
    // that should arrive as a side effect of an unrelated edit.
    expect(TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE).toBe(false);
  });

  it("blocks a user who has never accepted anything", () => {
    expect(
      needsTermsAcceptance({ licenseSigned: false, licenseVersion: null }),
    ).toBe(true);
  });

  describe("with re-consent off", () => {
    const off = { requireReacceptanceOnUpdate: false };

    it.each([
      ["the current version", CURRENT_TERMS_VERSION],
      ["a superseded version", STALE_VERSION],
      ["the legacy null version", null],
    ])("lets a signed user through with %s", (_label, licenseVersion) => {
      expect(
        needsTermsAcceptance({ licenseSigned: true, licenseVersion }, off),
      ).toBe(false);
    });

    it("still blocks a user who never accepted", () => {
      expect(
        needsTermsAcceptance(
          { licenseSigned: false, licenseVersion: null },
          off,
        ),
      ).toBe(true);
    });
  });

  describe("with re-consent on", () => {
    const on = { requireReacceptanceOnUpdate: true };

    it("lets a user through only on the current version", () => {
      expect(
        needsTermsAcceptance(
          { licenseSigned: true, licenseVersion: CURRENT_TERMS_VERSION },
          on,
        ),
      ).toBe(false);
    });

    it.each([
      ["a superseded version", STALE_VERSION],
      ["the legacy null version", null],
    ])("re-prompts a signed user on %s", (_label, licenseVersion) => {
      expect(
        needsTermsAcceptance({ licenseSigned: true, licenseVersion }, on),
      ).toBe(true);
    });
  });

  it("reduces to the old boolean check while the policy is off", () => {
    // The behavioural promise of this change: adding a version re-prompts
    // nobody by itself. Asserted across every combination rather than by
    // example, since it is the claim the rollout depends on.
    for (const licenseSigned of [true, false]) {
      for (const licenseVersion of [
        null,
        STALE_VERSION,
        CURRENT_TERMS_VERSION,
      ]) {
        expect(
          needsTermsAcceptance(
            { licenseSigned, licenseVersion },
            { requireReacceptanceOnUpdate: false },
          ),
        ).toBe(!licenseSigned);
      }
    }
  });
});
