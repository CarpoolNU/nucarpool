import * as fs from "fs";
import * as path from "path";
import {
  AMPLIFY_EXEMPT,
  MIN_EXPECTED_AMPLIFY_PATTERNS,
  amplifyCoverage,
  amplifyGrepPatterns,
  matchingPatterns,
  parseGrepPatterns,
} from "./check-env-contract";

/**
 * The `--amplify` half of the environment-contract check (SCRUM-385).
 *
 * `amplify.yml` is the deployed contract and `.env.example` is the
 * developer-facing one. Only the second was ever checked, so `S3_BUCKET_NAME`
 * could be required, carry a code default, and be absent from every grep
 * pattern - resolving to the console value at build time and to
 * `carpoolnubucket` at runtime, with nothing erroring.
 *
 * These tests matter more than most, because **a check that silently passes is
 * worse than no check**: it converts an open question into false assurance.
 * That is the failure mode `MIN_EXPECTED_VARS` was already guarding against in
 * this script, and the reason the parser has its own tripwires.
 *
 * Importing the module is safe because it only calls `main()` when run
 * directly - `scripts/check-driverless-groups.ts` is the same pattern.
 */

/** The shape of one build command, as it appears in the real file. */
const command = (pattern: string) =>
  `- env | grep -e ${pattern} >> .env.production`;

const spec = (...patterns: string[]) =>
  [
    "version: 1",
    "frontend:",
    "  phases:",
    "    build:",
    "      commands:",
    ...patterns.map((p) => `        ${command(p)}`),
    "        - yarn run build:${BUILD_ENV}",
  ].join("\n");

describe("parseGrepPatterns", () => {
  it("reads a single -e pattern", () => {
    expect(parseGrepPatterns(command("ACCESS"))).toEqual({
      patterns: ["ACCESS"],
    });
  });

  it("reads several -e patterns from one command", () => {
    expect(
      parseGrepPatterns("- env | grep -e ACCESS -e SECRET >> .env.production"),
    ).toEqual({ patterns: ["ACCESS", "SECRET"] });
  });

  it("reads --regexp= in both spellings", () => {
    expect(
      parseGrepPatterns("- env | grep --regexp=AZURE >> .env.production"),
    ).toEqual({ patterns: ["AZURE"] });
    expect(
      parseGrepPatterns("- env | grep --regexp PUSHER >> .env.production"),
    ).toEqual({ patterns: ["PUSHER"] });
  });

  it("reads a bare pattern, which grep accepts without -e", () => {
    expect(
      parseGrepPatterns("- env | grep DATABASE >> .env.production"),
    ).toEqual({ patterns: ["DATABASE"] });
  });

  it("strips quotes", () => {
    expect(
      parseGrepPatterns(`- env | grep -e "GOOGLE" >> .env.production`),
    ).toEqual({ patterns: ["GOOGLE"] });
    expect(
      parseGrepPatterns(`- env | grep -e 'GOOGLE' >> .env.production`),
    ).toEqual({ patterns: ["GOOGLE"] });
  });

  it("skips flags that carry no pattern", () => {
    // `-E` selects a dialect; reading it as a pattern would both invent a
    // pattern and lose the real one.
    expect(
      parseGrepPatterns("- env | grep -E -e AZURE >> .env.production"),
    ).toEqual({ patterns: ["AZURE"] });
  });

  it("does not mistake the redirect target for a pattern", () => {
    // The failure this guards against is subtle: `.env.production` parsed as a
    // pattern matches nothing, so coverage would look worse, not better - but
    // a bare-pattern command would silently lose its real pattern.
    const { patterns } = parseGrepPatterns(
      "- env | grep DATABASE >> .env.production",
    );
    expect(patterns).not.toContain(".env.production");
  });

  it("reports a -e with no pattern after it", () => {
    const { error } = parseGrepPatterns("- env | grep -e >> .env.production");
    expect(error).toMatch(/not followed by a pattern/);
  });

  it("reports grep called with no pattern at all", () => {
    const { error } = parseGrepPatterns("- env | grep >> .env.production");
    expect(error).toMatch(/no pattern/);
  });

  it("reports a command that writes the file without grep", () => {
    const { error } = parseGrepPatterns("- env >> .env.production");
    expect(error).toMatch(/without calling grep/);
  });
});

describe("amplifyGrepPatterns", () => {
  it("collects every pattern and counts the commands", () => {
    const result = amplifyGrepPatterns(spec("ACCESS", "DATABASE", "PUSHER"));

    expect(result.patterns).toEqual(["ACCESS", "DATABASE", "PUSHER"]);
    expect(result.commands).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("ignores prose that mentions the file", () => {
    // The real amplify.yml discusses .env.production at length in its header.
    // Counting a comment as a command would make the tripwire below unreliable
    // in the one direction that matters - looking healthier than it is.
    const withProse = [
      "# The env | grep lines write into .env.production so envsafe can read it.",
      "#   - env | grep -e NOT_A_REAL_COMMAND >> .env.production",
      spec("ACCESS"),
    ].join("\n");

    const result = amplifyGrepPatterns(withProse);
    expect(result.patterns).toEqual(["ACCESS"]);
    expect(result.commands).toBe(1);
  });

  it("finds no commands in a spec that does not write the file", () => {
    // Not an error here - the caller decides, and it fails rather than passing
    // vacuously.
    const result = amplifyGrepPatterns("version: 1\nfrontend:\n  phases: {}\n");
    expect(result.commands).toBe(0);
    expect(result.patterns).toEqual([]);
  });

  it("reports a malformed command with its line number", () => {
    const malformed = [
      "version: 1",
      "      commands:",
      "        - env | grep -e >> .env.production",
    ].join("\n");

    const { errors } = amplifyGrepPatterns(malformed);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("amplify.yml:3");
  });

  it("keeps parsing after a malformed command", () => {
    const mixed = [
      "      commands:",
      "        - env | grep -e >> .env.production",
      "        - env | grep -e PUSHER >> .env.production",
    ].join("\n");

    const { patterns, errors } = amplifyGrepPatterns(mixed);
    expect(errors).toHaveLength(1);
    expect(patterns).toEqual(["PUSHER"]);
  });
});

describe("matchingPatterns", () => {
  it("matches a pattern anywhere in the name, not just at the start", () => {
    // This is how three of the real variables are covered, and the reason the
    // patterns cannot simply be anchored with `^`.
    expect(matchingPatterns("SECRET_ACCESS_KEY_AWS", ["ACCESS"])).toEqual([
      "ACCESS",
    ]);
  });

  it("returns every pattern that matches", () => {
    expect(
      matchingPatterns("AZURE_CLIENT_SECRET", ["AZURE", "SECRET", "PUSHER"]),
    ).toEqual(["AZURE", "SECRET"]);
  });

  it("returns nothing for a name no pattern covers", () => {
    expect(matchingPatterns("S3_BUCKET_NAME", ["REGION", "ACCESS"])).toEqual(
      [],
    );
  });

  it("refuses to guess at a pattern that is not a literal name fragment", () => {
    // grep takes a POSIX basic regular expression and JavaScript takes a
    // different dialect, so evaluating one as the other would give a
    // confidently wrong answer about whether production has its environment.
    // Failing loudly is the point.
    const exit = jest.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => matchingPatterns("ANYTHING", ["^(A\\|B)"])).toThrow(
        "process.exit",
      );
      expect(error.mock.calls[0][0]).toMatch(
        /not a plain variable-name fragment/,
      );
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe("amplifyCoverage", () => {
  it("separates covered, exempt and uncovered", () => {
    const { covered, exempt, uncovered } = amplifyCoverage(
      ["DATABASE_URL", "SOMETHING_EXEMPT", "S3_BUCKET_NAME"],
      ["DATABASE"],
      { SOMETHING_EXEMPT: "supplied by the platform, not by the console" },
    );

    expect([...covered.keys()]).toEqual(["DATABASE_URL"]);
    expect([...exempt.keys()]).toEqual(["SOMETHING_EXEMPT"]);
    expect(uncovered).toEqual(["S3_BUCKET_NAME"]);
  });

  it("records which patterns covered a variable", () => {
    const { covered } = amplifyCoverage(
      ["SECRET_ACCESS_KEY_AWS"],
      ["ACCESS", "SECRET"],
    );
    expect(covered.get("SECRET_ACCESS_KEY_AWS")).toEqual(["ACCESS", "SECRET"]);
  });

  it("carries the exemption reason through, not just the fact of it", () => {
    // An exemption without a reason is the thing this ticket was filed about:
    // the reason is what makes it reviewable instead of a silent hole.
    const { exempt } = amplifyCoverage(["ANY_VAR"], ["DATABASE"], {
      ANY_VAR: "read only by the build, never at runtime",
    });
    expect(exempt.get("ANY_VAR")).toBe(
      "read only by the build, never at runtime",
    );
  });

  it("prefers a real grep pattern over an exemption", () => {
    // So that deleting a pattern surfaces as a change rather than being
    // quietly absorbed by the exemption list.
    const { covered, exempt } = amplifyCoverage(["PUSHER_SECRET"], ["PUSHER"], {
      PUSHER_SECRET: "should not be consulted",
    });
    expect([...covered.keys()]).toEqual(["PUSHER_SECRET"]);
    expect(exempt.size).toBe(0);
  });

  it("defaults to the real, empty exemption list", () => {
    // amplify.yml carries everything, so nothing should be exempt in practice.
    // If this starts failing, an exemption was added and needs the review that
    // the reason-bearing test below asks for.
    const { exempt, uncovered } = amplifyCoverage(
      ["DATABASE_URL"],
      ["DATABASE"],
    );
    expect(exempt.size).toBe(0);
    expect(uncovered).toEqual([]);
  });

  it("reports patterns that cover nothing required", () => {
    // NEXTAUTH_URL is the standing real example: NextAuth reads it straight
    // from process.env rather than through envsafe, so it is needed at runtime
    // and absent from the derived list. Informational, never a failure.
    const { unusedPatterns, uncovered } = amplifyCoverage(
      ["DATABASE_URL"],
      ["DATABASE", "NEXTAUTH_URL"],
    );
    expect(unusedPatterns).toEqual(["NEXTAUTH_URL"]);
    expect(uncovered).toEqual([]);
  });

  it("covers nothing when there are no patterns", () => {
    const { uncovered } = amplifyCoverage(["DATABASE_URL"], []);
    expect(uncovered).toEqual(["DATABASE_URL"]);
  });

  it("requires any exemption that is added to carry a real reason", () => {
    // The list is empty on purpose - amplify.yml carries every required
    // variable, including `NEXT_PUBLIC_*`, which is AWS's own documented
    // example. This asserts the shape rather than the emptiness, so adding a
    // legitimate exemption does not fail, but adding a blank reason does.
    for (const [name, reason] of Object.entries(AMPLIFY_EXEMPT)) {
      expect(typeof reason).toBe("string");
      expect(reason.trim().length).toBeGreaterThan(10);
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("the real amplify.yml", () => {
  const real = fs.readFileSync(
    path.join(__dirname, "..", "amplify.yml"),
    "utf8",
  );

  it("parses without malformed commands", () => {
    const { errors } = amplifyGrepPatterns(real);
    expect(errors).toEqual([]);
  });

  it("yields more patterns than the tripwire floor", () => {
    // If a restructure breaks the parser this drops to zero, and the CI check
    // would otherwise find nothing uncovered and pass.
    const { patterns } = amplifyGrepPatterns(real);
    expect(patterns.length).toBeGreaterThanOrEqual(
      MIN_EXPECTED_AMPLIFY_PATTERNS,
    );
  });

  it("carries S3_BUCKET_NAME, the variable that started this", () => {
    // Pinned by name rather than by the pattern that happens to cover it, so
    // rewriting `S3_` into something else is fine and deleting the coverage is
    // not.
    const { patterns } = amplifyGrepPatterns(real);
    expect(matchingPatterns("S3_BUCKET_NAME", patterns)).not.toEqual([]);
    expect(matchingPatterns("S3_REGION", patterns)).not.toEqual([]);
  });

  it("carries NEXT_PUBLIC_* rather than relying on build-time inlining", () => {
    // AWS's own example in the SSR environment-variables guide does this, and
    // it is what lets AMPLIFY_EXEMPT stay empty. Inlining would cover these
    // two today, but only because both are read through a literal
    // `process.env.NEXT_PUBLIC_X`.
    const { patterns } = amplifyGrepPatterns(real);
    expect(matchingPatterns("NEXT_PUBLIC_ENV", patterns)).not.toEqual([]);
    expect(
      matchingPatterns("NEXT_PUBLIC_MIXPANEL_PROJECT_TOKEN", patterns),
    ).not.toEqual([]);
  });
});
