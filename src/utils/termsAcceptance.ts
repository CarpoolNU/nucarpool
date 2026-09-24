/**
 * What the user accepted, which text they accepted, and whether they have to
 * accept it again.
 *
 * Three separate questions, and the whole point of this module is that the
 * third is not derivable from the first two. `user.license_signed` answered
 * "have they ever agreed"; it could not say *when* or *to what*, so there was
 * no audit trail for a disclaimer written on behalf of Northeastern and no way
 * to tell who had seen the current wording. SCRUM-280.
 *
 * The canonical location for all three. Nothing else should hard-code a terms
 * version or re-derive the gate condition.
 */

/**
 * The version stamped on `user.license_version` when somebody accepts today.
 *
 * **It names the text, not the release.** The date is the day the prose in
 * `CompliancePortal.tsx` last changed (commit `1af16f1`), not the day this
 * column was added — so a row recording `"2024-10-21"` genuinely identifies
 * the paragraphs that user read. Stamping today's date on unchanged text
 * would put two version strings on one wording and make the record worth
 * less than the boolean it replaces.
 *
 * A date rather than a semver or a content hash because a human reading an
 * audit row should be able to place it without a lookup table. The hash below
 * is what actually detects a change; this string is what gets stored.
 *
 * **Editing the terms means bumping this**, and
 * `TERMS_TEXT_FINGERPRINT` with it. `termsText.test.ts` fails if the prose
 * moves and this file does not.
 */
export const CURRENT_TERMS_VERSION = "2024-10-21";

/**
 * SHA-256 of the normalised legal prose that `CURRENT_TERMS_VERSION` names.
 *
 * Recorded so a wording change cannot land silently. `termsText.test.ts`
 * re-derives it from `CompliancePortal.tsx`; see that file for what
 * "normalised" covers and why it survives reformatting.
 */
export const TERMS_TEXT_FINGERPRINT =
  "db3269c6b18ca18b541a20f0917e7cd26c9c9b33f3ecbaf1992679d359eb7e46";

/**
 * **Policy, not mechanism: does a newer terms version block the app until the
 * user accepts again?**
 *
 * Deliberately separate from `CURRENT_TERMS_VERSION`, and deliberately `false`.
 * Bumping a version is an engineering act; forcing thousands of users back
 * through a blocking modal is a university and legal decision, and the terms
 * themselves currently say the opposite — *"These terms are subject to
 * updates, and continued use of the service constitutes acknowledgment of
 * those updates."* Under that wording re-consent is not required, so wiring
 * the two together would have the code contradict the document it is
 * enforcing.
 *
 * What the version buys while this stays `false` is the record: from now on
 * every acceptance says which text it was, so if the owners of the terms
 * language later want re-consent, this flag is the one line that delivers it
 * and the data to target it already exists.
 *
 * **Turning this on re-prompts every pre-existing row**, including the ~3,341
 * production users whose `license_version` is null because they accepted
 * before the column existed. That is a feature — see "Terms acceptance" in
 * `src/server/db/README.md` for why those rows were never trustworthy — but it
 * is not a quiet change, so it wants a human decision rather than a default.
 */
export const TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE = false;

/**
 * The columns the questions below are answered from. Structural rather than
 * the `User` type, so the server, `ComplianceGate` and the tests can all pass
 * whatever they happen to be holding.
 */
export type TermsAcceptanceRecord = {
  licenseSigned: boolean;
  licenseVersion: string | null;
};

/**
 * Whether this user accepted **the wording currently shown**.
 *
 * A fact about the record, with no policy in it. False for the legacy cohort,
 * whose `licenseVersion` is null however long ago they clicked I Agree.
 */
export const hasAcceptedCurrentTerms = (
  record: TermsAcceptanceRecord,
): boolean =>
  record.licenseSigned && record.licenseVersion === CURRENT_TERMS_VERSION;

/**
 * Whether the blocking modal should be shown. This is the gate condition, and
 * the only one.
 *
 * Never accepting anything always blocks. A stale version blocks only if
 * `TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE` says it should, which is what keeps
 * the re-consent decision out of the version bump.
 *
 * @param options.requireReacceptanceOnUpdate overrides the module-level policy.
 *   Exists so the off-by-default branch is reachable from a test without
 *   module mocking; production callers pass nothing.
 */
export const needsTermsAcceptance = (
  record: TermsAcceptanceRecord,
  {
    requireReacceptanceOnUpdate = TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE,
  }: { requireReacceptanceOnUpdate?: boolean } = {},
): boolean =>
  !record.licenseSigned ||
  (requireReacceptanceOnUpdate && !hasAcceptedCurrentTerms(record));
