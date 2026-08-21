import { parseArgs } from "./cleanup-orphan-locations";

/**
 * The script deletes production rows, so the argument parser is the last thing
 * standing between a typo and data loss. These pin the two properties that
 * matter: deleting is opt-in, and anything unrecognised stops the run rather
 * than being ignored.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

describe("cleanup-orphan-locations argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("only deletes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // An explicit --dry-run after --apply wins, so the more cautious of two
    // conflicting flags is the one that takes effect.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    // `--aply` must not silently become a dry run that the operator reads as
    // "it deleted nothing, so there was nothing to delete".
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["extra"])).toThrow(/unknown argument/);
  });

  it("accepts a raised cap", () => {
    expect(parseArgs(["--apply", "--max", "2000"])).toEqual({
      apply: true,
      max: 2000,
    });
  });

  it("rejects a cap that is not a positive integer", () => {
    for (const bad of ["abc", "0", "-1", "1.5", ""]) {
      expect(() => parseArgs(["--max", bad])).toThrow(/positive integer/);
    }
    expect(() => parseArgs(["--max"])).toThrow(/positive integer/);
  });
});
