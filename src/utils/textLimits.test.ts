import { readFileSync } from "fs";
import { join } from "path";
import {
  GROUP_NOTES_MAX_LENGTH,
  GROUP_OPTION_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  PROFILE_TEXT_MAX_LENGTH,
} from "./textLimits";

/**
 * Each constant in `textLimits.ts` must equal the width of the column its text
 * is written to. That is the module's entire purpose, and nothing verified it.
 *
 * Every other test of these limits builds its input *from* the constant —
 * `"a".repeat(MESSAGE_MAX_LENGTH)` — so it checks that a Zod schema uses the
 * same number the test uses. Useful, but it cannot notice the number drifting
 * away from the database: raise `MESSAGE_MAX_LENGTH` to 300 and every one of
 * those tests still passes, while a 260-character message now passes validation
 * and then makes MySQL throw `P2000` on write, after the send bar has already
 * cleared the user's text. That is the failure this file exists to catch, and it
 * needs the schema as the other half of the comparison.
 *
 * `__dirname` rather than `process.cwd()`, so the suite does not depend on where
 * Jest was invoked from.
 */

const SCHEMA = readFileSync(
  join(__dirname, "..", "..", "prisma", "schema.prisma"),
  "utf8",
);

/**
 * The attribute text of one `model.field` declaration.
 *
 * Deliberately strict: it matches a field only inside the named model, so
 * `message` on `Request` is not confused with `message` on `CarpoolGroup`.
 * Throws rather than returning null, because a renamed or deleted column should
 * fail this suite loudly instead of quietly skipping the check.
 */
const fieldAttributes = (model: string, field: string): string => {
  const block = new RegExp(`^model ${model} \\{$([\\s\\S]*?)^\\}$`, "m").exec(
    SCHEMA,
  );
  if (!block?.[1]) {
    throw new Error(`No model ${model} in schema.prisma`);
  }

  const line = new RegExp(`^\\s+${field}\\s+\\S+(.*)$`, "m").exec(block[1]);
  if (!line) {
    throw new Error(`No field ${model}.${field} in schema.prisma`);
  }

  return line[1] ?? "";
};

/** The `n` in `@db.VarChar(n)`, or null when the field carries no annotation. */
const declaredVarCharWidth = (model: string, field: string): number | null => {
  const match = /@db\.VarChar\((\d+)\)/.exec(fieldAttributes(model, field));
  return match?.[1] ? Number(match[1]) : null;
};

/**
 * Prisma's width for an unannotated `String` on MySQL. Four profile columns rely
 * on it rather than stating a width, so the constant that guards them is only
 * correct while that stays true.
 */
const PRISMA_DEFAULT_STRING_WIDTH = 191;

describe("the limits match the columns they guard", () => {
  it.each([
    ["Message", "content", MESSAGE_MAX_LENGTH],
    ["Request", "message", MESSAGE_MAX_LENGTH],
    ["CarpoolSearch", "groupNotes", GROUP_NOTES_MAX_LENGTH],
    ["CarpoolSearch", "groupMusicPreference", GROUP_OPTION_MAX_LENGTH],
    ["CarpoolSearch", "groupConversationStyle", GROUP_OPTION_MAX_LENGTH],
  ])("%s.%s is VarChar(%i)", (model, field, limit) => {
    expect(declaredVarCharWidth(model, field)).toBe(limit);
  });

  it.each([
    ["User", "bio"],
    ["User", "preferredName"],
    ["User", "pronouns"],
    ["CarpoolSearch", "companyName"],
  ])(
    "%s.%s still relies on Prisma's default width, which is what PROFILE_TEXT_MAX_LENGTH encodes",
    (model, field) => {
      // Annotating one of these with a *narrower* width would make
      // PROFILE_TEXT_MAX_LENGTH too permissive, and the failure would show up as
      // a 500 on save rather than as a validation message. An explicit
      // annotation is not wrong in itself - it just has to be reflected here.
      expect(declaredVarCharWidth(model, field)).toBeNull();
      expect(PROFILE_TEXT_MAX_LENGTH).toBe(PRISMA_DEFAULT_STRING_WIDTH);
    },
  );
});

describe("the parser this suite depends on", () => {
  // If `fieldAttributes` silently returned "" for a missing column, every
  // assertion above would read `null` and the VarChar tests would fail loudly -
  // but the "relies on the default" tests would pass for a column that no longer
  // exists. These pin the throwing behaviour that prevents that.
  it("throws for a model that is not in the schema", () => {
    expect(() => fieldAttributes("NoSuchModel", "id")).toThrow(
      "No model NoSuchModel",
    );
  });

  it("throws for a field that is not on the model", () => {
    expect(() => fieldAttributes("Message", "noSuchField")).toThrow(
      "No field Message.noSuchField",
    );
  });

  it("reads a width that is actually declared", () => {
    // A self-check on the regex: `Message.content` is annotated in the schema,
    // so a null here would mean the parser is broken rather than the schema
    // being unannotated - the two are indistinguishable to the tests above.
    expect(declaredVarCharWidth("Message", "content")).not.toBeNull();
  });

  it("does not confuse fields of the same name on different models", () => {
    // `message` exists on both Request and CarpoolGroup with different widths.
    expect(declaredVarCharWidth("Request", "message")).toBe(255);
    expect(declaredVarCharWidth("CarpoolGroup", "message")).toBeNull();
  });
});
