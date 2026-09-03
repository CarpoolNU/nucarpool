import { parseArgs } from "./repair-seat-residue";

/**
 * The script updates a column and deletes a row, so the argument parser is the
 * last thing standing between a typo and a write nobody intended. These pin the
 * same two properties as `cleanup-orphan-locations.test.ts`: writing is opt-in,
 * and anything unrecognised stops the run rather than being ignored.
 *
 * The selection and the repair values are covered in
 * `src/server/db/seatIntegrity.test.ts`, which is where the planning half
 * lives. Importing this module is safe because it only calls main() when run
 * directly.
 */

describe("repair-seat-residue argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("only writes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // An explicit --dry-run after --apply wins, so the more cautious of two
    // conflicting flags is the one that takes effect.
    expect(parseArgs(["--apply", "--dry-run"]).apply).toBe(false);
  });

  it("rejects anything it does not recognise instead of ignoring it", () => {
    // `--aply` must not silently become a dry run that the operator reads as
    // "it wrote nothing, so there was nothing to repair".
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
