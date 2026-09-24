/**
 * The guard that makes a stored terms version mean anything.
 *
 * `user.license_version` records which wording a user agreed to. That record is
 * worth exactly as much as the promise that the string changes when the wording
 * does - and nothing enforces a promise like that except a test. Without this,
 * an editor improving a sentence in `CompliancePortal.tsx` would leave every
 * subsequent acceptance stamped with a version naming text that no longer
 * exists, which is worse than the bare boolean it replaced: it is a wrong
 * answer rather than no answer. SCRUM-280.
 *
 * **What is fingerprinted is the prose, not the file.** The body of every
 * `<p>` outside the error alert, with tags, JSX expressions and all whitespace
 * normalised away. That distinction is the point: the terms have survived
 * seven commits that rewrote the mutation, migrated the dialog to Tailwind v4
 * and restructured it for assistive technology, and this fingerprint is
 * unchanged across all of them. It moves only when somebody edits the words.
 *
 * Reading the source file rather than rendering the component is deliberate.
 * Rendering would also pick up the title and the button, both of which are
 * interface rather than terms, and would tie a legal check to React.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import {
  CURRENT_TERMS_VERSION,
  TERMS_TEXT_FINGERPRINT,
} from "./termsAcceptance";

const PORTAL_PATH = join(__dirname, "..", "components", "CompliancePortal.tsx");

/**
 * The error message rendered on a failed write. It is the one `<p>` in the file
 * that is not part of the terms, and it is identified by the attribute that
 * makes it an alert rather than by its text.
 */
const ALERT_ATTRIBUTE = 'role="alert"';

const termsParagraphs = (): string[] =>
  [
    // `[\s\S]` rather than `.` with the `s` flag: paragraphs span lines, and
    // the flag needs an ES2018 target this project does not set.
    ...readFileSync(PORTAL_PATH, "utf8").matchAll(
      /<p\b([^>]*)>([\s\S]*?)<\/p>/g,
    ),
  ]
    .filter(([, attributes]) => !attributes.includes(ALERT_ATTRIBUTE))
    .map(([, , body]) =>
      body
        // Nested markup - `<br />` and the like - is layout, not wording.
        .replace(/<[^>]*>/g, "")
        // `{" "}` and any other JSX expression. None of the terms are
        // interpolated; if one ever is, the fingerprint changes and this test
        // fails, which is the correct outcome.
        .replace(/\{[^{}]*\}/g, "")
        // JSX collapses source newlines and indentation when rendering, so a
        // reflow is not a wording change.
        .replace(/\s+/g, " ")
        .trim(),
    );

describe("the terms text and the version that names it", () => {
  it("finds the three paragraphs of the disclaimer", () => {
    // A positive control for the extraction above. Without it, a regex that
    // silently matched nothing would produce a stable fingerprint over an
    // empty string and this suite would pass while checking nothing at all.
    const paragraphs = termsParagraphs();

    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toContain("provided on an AS IS basis");
    expect(paragraphs[1]).toContain("indemnify and hold harmless Northeastern");
    expect(paragraphs[2]).toContain("continued use");
    for (const paragraph of paragraphs) {
      expect(paragraph.length).toBeGreaterThan(400);
    }
  });

  it("excludes the failure alert, which is interface rather than terms", () => {
    expect(termsParagraphs().join(" ")).not.toContain(
      "We could not record your agreement",
    );
  });

  it("still matches the fingerprint CURRENT_TERMS_VERSION names", () => {
    const actual = createHash("sha256")
      .update(termsParagraphs().join("\n"))
      .digest("hex");

    // Thrown *before* the assertion rather than after it. Jest takes no custom
    // message on `toBe`, and a failing `expect` ends the test - so guidance
    // placed below it would never be reached on the one run that needs it.
    // Whoever trips this is editing prose and is not looking for a versioning
    // scheme, so the failure has to say what to do.
    if (actual !== TERMS_TEXT_FINGERPRINT) {
      throw new Error(
        `The terms in CompliancePortal.tsx changed, but CURRENT_TERMS_VERSION ` +
          `is still "${CURRENT_TERMS_VERSION}". In src/utils/termsAcceptance.ts, ` +
          `set CURRENT_TERMS_VERSION to today's date and ` +
          `TERMS_TEXT_FINGERPRINT to "${actual}". Then decide, with whoever ` +
          `owns the terms language, whether ` +
          `TERMS_REQUIRE_REACCEPTANCE_ON_UPDATE should become true.`,
      );
    }

    expect(actual).toBe(TERMS_TEXT_FINGERPRINT);
  });
});
