import { TextTooLongError } from "../../shared/errors";
import {
  SEARCH_TERM_MAX_LENGTH,
  escapeLikeWildcards,
  normalizeSearchTerm,
} from "./searchTerm";

describe("normalizeSearchTerm", () => {
  it("trims the term", () => {
    expect(normalizeSearchTerm("  garage  ")).toBe("garage");
  });

  it("reads an absent term as no search", () => {
    expect(normalizeSearchTerm(undefined)).toBeNull();
  });

  it("reads an all-whitespace term as no search", () => {
    // The search box submits on Enter, and Enter on an empty box is a request
    // for the unfiltered feed rather than a search for nothing.
    expect(normalizeSearchTerm("   ")).toBeNull();
  });

  it("refuses a term longer than the cap", () => {
    expect(() =>
      normalizeSearchTerm("x".repeat(SEARCH_TERM_MAX_LENGTH + 1)),
    ).toThrow(TextTooLongError);
  });

  it("accepts a term exactly at the cap", () => {
    const atCap = "x".repeat(SEARCH_TERM_MAX_LENGTH);
    expect(normalizeSearchTerm(atCap)).toBe(atCap);
  });

  it("measures the cap after trimming", () => {
    // Otherwise a term that fits is refused for the spaces around it.
    const padded = ` ${"x".repeat(SEARCH_TERM_MAX_LENGTH)} `;
    expect(normalizeSearchTerm(padded)).toBe(
      "x".repeat(SEARCH_TERM_MAX_LENGTH),
    );
  });
});

describe("escapeLikeWildcards", () => {
  it("leaves an ordinary term alone", () => {
    expect(escapeLikeWildcards("garage")).toBe("garage");
  });

  it("escapes a percent so it matches a literal percent", () => {
    // "50% off" must not become "50<anything> off".
    expect(escapeLikeWildcards("50%")).toBe("50\\%");
  });

  it("escapes an underscore so it matches a literal underscore", () => {
    expect(escapeLikeWildcards("a_b")).toBe("a\\_b");
  });

  it("escapes a backslash before it can escape something else", () => {
    // Done in the wrong order, the backslash this adds for the `%` would
    // itself be escaped, and the `%` would go back to being a wildcard.
    expect(escapeLikeWildcards("\\%")).toBe("\\\\\\%");
  });

  it("escapes every wildcard in a term, not just the first", () => {
    expect(escapeLikeWildcards("%a%b%")).toBe("\\%a\\%b\\%");
  });
});
