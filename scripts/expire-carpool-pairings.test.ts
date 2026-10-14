import { parseArgs } from "./expire-carpool-pairings";
import {
  PAIRING_RETENTION_MONTHS,
  pairingRetentionCutoff,
} from "../src/server/db/carpoolPairing";

/**
 * The script deletes production rows, so the argument parser is the last thing
 * standing between a typo and data loss. Same two properties as
 * `cleanup-orphan-locations.test.ts`: deleting is opt-in, and anything
 * unrecognised stops the run rather than being ignored.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

describe("expire-carpool-pairings argument parsing", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false, max: 500 });
  });

  it("only deletes when --apply is given", () => {
    expect(parseArgs(["--apply"]).apply).toBe(true);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
    // The more cautious of two conflicting flags is the one that takes effect.
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

describe("the window the sweep deletes by", () => {
  /**
   * The script and the application must agree on the window, or a row would
   * be hidden by one and kept by the other — and the retention decision was
   * explicitly that the rows are gone, not merely hidden. They agree by
   * sharing `pairingRetentionCutoff` rather than by each computing twelve
   * months; this pins the value that helper is documented to hold, so a change
   * to the retention period has to be a deliberate change to the decision
   * record as well.
   */
  it("is the twelve months the retention decision names", () => {
    expect(PAIRING_RETENTION_MONTHS).toBe(12);

    expect(
      pairingRetentionCutoff(new Date("2026-10-14T12:00:00.000Z")),
    ).toEqual(new Date("2025-10-14T12:00:00.000Z"));
  });
});
