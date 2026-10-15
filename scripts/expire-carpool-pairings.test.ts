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

/**
 * The trigger this sweep still does not have.
 *
 * SCRUM-675 settled *how* expiry should run — a scheduled Lambda beside the
 * report digest in `infra/` — and deliberately did not build it, because
 * nobody working in this repository has an AWS account to deploy into.
 * SCRUM-677 carries that work. Until it lands the sweep is a hand-run chore,
 * and a hand-run chore is a process control: nothing in the repository makes
 * anybody run it.
 *
 * **This is the part that is not a process control.** `carpool_pairing` rows
 * began accumulating when SCRUM-636 merged on 2026-10-14, so the earliest row
 * can fall outside the twelve-month window on 2027-10-14. This trips on
 * 2027-07-01, three months earlier, and the failure message is the handover to
 * whoever is there.
 *
 * It is a deliberate landmine, and the two softer options were considered and
 * rejected: a warning printed by a passing test is read by nobody, and a
 * calendar reminder lives outside the repository, where a future reader of
 * this directory cannot find it. A red check cannot be missed. Moving the date
 * is a legitimate answer — see the message below — provided the reason is
 * recorded where the decision lives.
 */
describe("the trigger this sweep still does not have", () => {
  const REVIEW_DEADLINE = Date.parse("2027-07-01T00:00:00.000Z");

  const INSIDE_WINDOW =
    "the retention window still has headroom; nothing is overdue";

  // Written flush to the left margin rather than indented to match the code:
  // every leading space inside a template literal is part of the string, and
  // this one exists to be read in CI output rather than in the source.
  const OVERDUE = `
It is 2027-07-01 or later and scripts/expire-carpool-pairings.ts STILL HAS NO TRIGGER.

carpool_pairing rows begin falling outside the twelve-month retention window on
2027-10-14. The commitment recorded on SCRUM-636 is that an expired row is GONE,
not merely hidden from readers - so from that date, every month nobody runs this
sweep is a month in which the retention position is not true.

Three ways to resolve this, in order of preference:

  1. Finish SCRUM-677 - the scheduled Lambda that SCRUM-675 chose and could not
     build without AWS access. This test is deleted as part of that work.

  2. Run the sweep by hand, and keep running it:
       npx ts-node scripts/expire-carpool-pairings.ts           # what would go
       npx ts-node scripts/expire-carpool-pairings.ts --apply   # delete it
     Then record the run on SCRUM-677. There is deliberately no run-state table
     in this repository, so an unrecorded run is an unanswerable question.

  3. Move REVIEW_DEADLINE below - but only if deferring is a deliberate
     decision, and say why on SCRUM-677. "This test is in the way" is not one.

Deleting this test without doing one of those three removes the only thing in
this repository that enforces the retention window at all.
`;

  /**
   * Two strings rather than a boolean, so that Jest's own diff prints the
   * message above in full. `expect(onTime).toBe(true)` fails with "expected
   * false", which tells a reader in July 2027 nothing about what to do next.
   */
  const schedulingStatus = (now: number): string =>
    now < REVIEW_DEADLINE ? INSIDE_WINDOW : OVERDUE;

  it("stays quiet while the deadline is still ahead", () => {
    expect(schedulingStatus(REVIEW_DEADLINE - 1)).toBe(INSIDE_WINDOW);
  });

  it("trips the moment the deadline arrives", () => {
    expect(schedulingStatus(REVIEW_DEADLINE)).toBe(OVERDUE);
  });

  it("has not reached the deadline, or the sweep has a trigger by now", () => {
    expect(schedulingStatus(Date.now())).toBe(INSIDE_WINDOW);
  });
});
