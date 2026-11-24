import { HandleInvalidError } from "../../shared/errors";
import { HANDLE_MAX_LENGTH, parseHandle } from "./handle";

describe("parseHandle", () => {
  it("preserves display casing and lowercases the normalized form", () => {
    expect(parseHandle("HuskyCommuter")).toEqual({
      display: "HuskyCommuter",
      normalized: "huskycommuter",
    });
  });

  it("collides casings onto one normalized form", () => {
    // This is the whole reason the normalized column exists.
    expect(parseHandle("Husky").normalized).toBe(
      parseHandle("HUSKY").normalized,
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseHandle("  husky  ").display).toBe("husky");
  });

  it("folds fullwidth characters onto ASCII rather than rejecting them", () => {
    expect(parseHandle("ｈｕｓｋｙ").normalized).toBe("husky");
  });

  it("rejects a Cyrillic homoglyph that would render as a Latin handle", () => {
    // U+0430 CYRILLIC SMALL LETTER A renders identically to "a". NFKC does not
    // fold it, so the ASCII-only rule is what stops the impersonation.
    expect(() => parseHandle("pаrking")).toThrow(HandleInvalidError);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["too short", "ab"],
    ["too long", "a".repeat(HANDLE_MAX_LENGTH + 1)],
    ["a space inside", "husky commuter"],
    ["punctuation", "husky!"],
    ["a hyphen", "husky-commuter"],
    ["leading underscore", "_husky"],
    ["trailing underscore", "husky_"],
  ])("rejects %s", (_label, input) => {
    expect(() => parseHandle(input)).toThrow(HandleInvalidError);
  });

  it.each(["admin", "Admin", "MODERATOR", "nucarpool", "northeastern"])(
    "rejects the reserved handle %s whatever its casing",
    (input) => {
      expect(() => parseHandle(input)).toThrow(/reserved/i);
    },
  );

  it("accepts an interior underscore and digits", () => {
    expect(parseHandle("husky_42").normalized).toBe("husky_42");
  });
});
