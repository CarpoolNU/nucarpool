import { Role } from "@prisma/client";
import type { TransactionClient } from "./client";

/**
 * The durable record that two users carpooled, written when they part.
 *
 * `CarpoolPairing` in `schema.prisma` carries the reasoning about the row
 * itself. This module is the two halves of writing one: {@link buildPairings}
 * decides *which* rows a parting produces, and {@link recordPairings} writes
 * them without ever being able to fail the parting.
 *
 * **The split is the testable part.** Which pairs a dissolution produces, and
 * who is recorded as the driver, are pure functions of the membership — so
 * they are decided here and asserted in `carpoolPairing.test.ts` against a
 * table of memberships, rather than inferred from a database test that can
 * only show the end state of one scenario at a time.
 */

/**
 * Retention, decided on SCRUM-636 (2026-10-08) and restated in the database
 * README.
 *
 * Measured from `endedAt`, not `formedAt`: a carpool that ran for a year is
 * not already half-expired the day it ends. Twelve months covers a co-op
 * cycle plus the following term, which is what makes "report them afterwards"
 * and "ride with them again next term" both possible, while stopping short of
 * a permanent social graph.
 */
export const PAIRING_RETENTION_MONTHS = 12;

/**
 * The oldest `endedAt` still inside the retention window.
 *
 * Month arithmetic rather than a day or millisecond count, deliberately:
 * `setMonth` lands on the same day of the month a year earlier regardless of
 * leap days or the two daylight-saving transitions in between, where
 * `365 * 24 * 60 * 60 * 1000` drifts by an hour twice a year and by a day
 * every fourth. A pairing row's lifetime should not depend on which side of a
 * DST boundary it ended.
 */
export const pairingRetentionCutoff = (now: Date): Date => {
  const cutoff = new Date(now.getTime());
  cutoff.setMonth(cutoff.getMonth() - PAIRING_RETENTION_MONTHS);
  return cutoff;
};

/** One member of the group that is being taken apart. */
export type PairingMember = {
  userId: string;
  role: Role;
};

/** A `CarpoolPairing` row, before it is written. */
export type PairingRow = {
  groupId: string;
  userAId: string;
  userBId: string;
  driverId: string | null;
  formedAt: Date | null;
  endedAt: Date;
};

/**
 * Who the group's driver was, or null.
 *
 * Null is a real answer, not a failure: `SCRUM-406` established that
 * driverless groups exist in production, and `groups.edit` deliberately lets
 * their riders leave one at a time rather than trapping them. A pairing from
 * such a group records no driver instead of guessing one, because the first
 * member of an arbitrarily ordered list is not a driver and storing them as
 * one would be a quiet lie to everything that reads the column.
 */
const driverIdOf = (members: readonly PairingMember[]): string | null =>
  members.find((member) => member.role === Role.DRIVER)?.userId ?? null;

/**
 * The two user ids in the canonical order the schema stores them in.
 *
 * Sorting here rather than at the call sites is what makes "did these two
 * carpool" a single indexed lookup for a reader who knows the pair but not
 * which of them drove.
 */
const orderedPair = (first: string, second: string): [string, string] =>
  first < second ? [first, second] : [second, first];

/**
 * The pairing rows a parting produces.
 *
 * `departing` is the member who is leaving, or null when the whole group is
 * being dissolved at once:
 *
 *   - **A dissolution** (`departing: null`) ends every pairing in the group,
 *     so it produces every unordered pair of its members. A group of three
 *     writes three rows, because all three travelled together — a rider who
 *     wants to report the *other* rider afterwards needs that row as much as
 *     one reporting the driver.
 *   - **A single departure** ends only that member's pairings, so it produces
 *     one row per other member. The pairs that remain are still live and are
 *     recorded when they themselves end.
 *
 * Taken together those two cases record each pairing exactly once: a rider
 * removed from a group of three writes two rows and leaves one pair behind,
 * and that pair is written when the group later dissolves.
 *
 * `members` must be the membership as it stood *before* the detach, including
 * the departing member. A caller that reads it afterwards sees a group the
 * departing member has already left and silently records nothing.
 */
export const buildPairings = ({
  groupId,
  members,
  departing,
  formedAt,
  endedAt,
}: {
  groupId: string;
  members: readonly PairingMember[];
  departing: string | null;
  formedAt: Date | null;
  endedAt: Date;
}): PairingRow[] => {
  const driverId = driverIdOf(members);
  const userIds = members.map((member) => member.userId);

  const pairs: [string, string][] = [];

  if (departing === null) {
    for (let i = 0; i < userIds.length; i++) {
      for (let j = i + 1; j < userIds.length; j++) {
        pairs.push(orderedPair(userIds[i], userIds[j]));
      }
    }
  } else if (userIds.includes(departing)) {
    // A departing member the list does not contain produces nothing rather
    // than a row pairing them with the whole group: that combination means
    // the caller read the membership after the detach, and inventing rows
    // from it would record pairings that may never have existed.
    for (const userId of userIds) {
      if (userId !== departing) {
        pairs.push(orderedPair(departing, userId));
      }
    }
  }

  return pairs.map(([userAId, userBId]) => ({
    groupId,
    userAId,
    userBId,
    driverId,
    formedAt,
    endedAt,
  }));
};

/**
 * Writes the rows, inside the caller's transaction, without being able to
 * fail it.
 *
 * **Both halves of that sentence are requirements, and they pull against each
 * other.** The write has to be *inside* the teardown transaction, because a
 * pairing recorded by a transaction that then rolled back would describe a
 * parting that never happened, and one written afterwards would be missing
 * whenever the process died in between. But a pairing write that *fails* the
 * teardown would leave a user in a group they pressed Leave on — and the open
 * exits are a rule this repository holds above almost everything else
 * (`src/server/db/blocks.ts`, SCRUM-554). A missing row is recoverable; a
 * trapped user is not.
 *
 * The resolution is this `catch`. Prisma's interactive transactions roll back
 * when the callback throws, so swallowing the error here is what keeps the
 * detach and the seat credit committing — and InnoDB rolls back only the
 * failed statement, not the transaction, so the surrounding writes are intact
 * rather than merely uncommitted. Parting wins; the record is best-effort.
 *
 * **The log is not a control.** It records the loss for whoever is reading at
 * the time, but this repository has no known destination for deployed server
 * logs, so nothing alerts on it and nothing reconciles it afterwards. The
 * honest statement of the guarantee is that a pairing row is written on every
 * parting *whose insert succeeds*, and that the only thing protecting it is
 * that the insert references no other row and so has very little to fail on.
 *
 * `createMany` rather than a row at a time so a dissolution of three is one
 * statement: partial success within one parting would be the one outcome
 * worse than none, because a reader cannot tell a pair who never shared a
 * group from a pair whose row was the one that did not land.
 */
export const recordPairings = async (
  tx: TransactionClient,
  rows: readonly PairingRow[],
): Promise<number> => {
  if (rows.length === 0) {
    return 0;
  }

  try {
    const written = await tx.carpoolPairing.createMany({ data: [...rows] });
    return written.count;
  } catch (error) {
    console.error(
      "Could not record a carpool pairing; the parting itself still stands",
      error,
    );
    return 0;
  }
};
