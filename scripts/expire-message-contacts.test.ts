import { parseArgs } from "./expire-message-contacts";
import {
  CONTACT_RETENTION_MONTHS,
  contactRetentionCutoff,
} from "../src/server/db/messageContact";

/**
 * The sibling of `expire-carpool-pairings.test.ts`, for the other retained
 * record (SCRUM-676).
 *
 * The script deletes production rows, so the argument parser is the last thing
 * standing between a typo and data loss. Same two properties: deleting is
 * opt-in, and anything unrecognised stops the run rather than being ignored.
 *
 * Importing the module is safe because it only calls main() when run directly.
 */

describe("expire-message-contacts argument parsing", () => {
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
   * sharing `contactRetentionCutoff` rather than by each computing twelve
   * months; this pins the value that helper is documented to hold, so a change
   * to the retention period has to be a deliberate change to the decision
   * record as well.
   */
  it("is the twelve months the retention decision names", () => {
    expect(CONTACT_RETENTION_MONTHS).toBe(12);

    expect(
      contactRetentionCutoff(new Date("2026-10-15T12:00:00.000Z")),
    ).toEqual(new Date("2025-10-15T12:00:00.000Z"));
  });
});

/**
 * The trigger this sweep does not have either.
 *
 * SCRUM-675 settled *how* expiry should run — a scheduled Lambda beside the
 * report digest in `infra/` — and deliberately did not build it, because
 * nobody working in this repository has an AWS account to deploy into.
 * SCRUM-677 carries that work, and **now has two sweeps to schedule rather
 * than one**, which is recorded on that ticket.
 *
 * `message_contact` rows begin accumulating when SCRUM-676 merges, so the
 * earliest row can fall outside the twelve-month window twelve months later.
 * This trips on the same 2027-07-01 as the pairing sweep's tripwire rather
 * than on its own date: the two records are swept by the same unbuilt
 * scheduler, so splitting the deadlines would mean two separate landmines for
 * one piece of missing work, and the earlier of the two is the one that
 * matters.
 *
 * It is a deliberate landmine, for the reasons the sibling test records: a
 * warning printed by a passing test is read by nobody, and a calendar reminder
 * lives outside the repository. Moving the date is a legitimate answer
 * provided the reason is recorded where the decision lives.
 */
describe("the trigger this sweep does not have", () => {
  const REVIEW_DEADLINE = Date.parse("2027-07-01T00:00:00.000Z");

  const INSIDE_WINDOW =
    "the retention window still has headroom; nothing is overdue";

  // Written flush to the left margin rather than indented to match the code:
  // every leading space inside a template literal is part of the string, and
  // this one exists to be read in CI output rather than in the source.
  const OVERDUE = `
It is 2027-07-01 or later and scripts/expire-message-contacts.ts STILL HAS NO TRIGGER.

message_contact rows fall outside the twelve-month retention window twelve months
after SCRUM-676 shipped. The commitment recorded on SCRUM-676, carried over from
SCRUM-636, is that an expired row is GONE, not merely hidden from readers - so
every month nobody runs this sweep is a month in which the retention position is
not true.

Three ways to resolve this, in order of preference:

  1. Finish SCRUM-677 - the scheduled Lambda that SCRUM-675 chose and could not
     build without AWS access. It has TWO sweeps to schedule: this one and
     scripts/expire-carpool-pairings.ts. This test is deleted as part of that
     work, alongside its sibling.

  2. Run the sweep by hand, and keep running it:
       npx ts-node scripts/expire-message-contacts.ts           # what would go
       npx ts-node scripts/expire-message-contacts.ts --apply   # delete it
     Then record the run on SCRUM-677. There is deliberately no run-state table
     in this repository, so an unrecorded run is an unanswerable question.

  3. Move REVIEW_DEADLINE below - but only if deferring is a deliberate
     decision, and say why on SCRUM-677. "This test is in the way" is not one.

Deleting this test without doing one of those three removes the only thing in
this repository that enforces this record's retention window at all.
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
