import { Role } from "@prisma/client";
import {
  PAIRING_RETENTION_MONTHS,
  buildPairings,
  pairingRetentionCutoff,
  recordPairings,
} from "./carpoolPairing";
import type { PairingMember } from "./carpoolPairing";
import type { TransactionClient } from "./client";

/**
 * Which rows a parting produces, and the guarantee that producing them cannot
 * fail the parting.
 *
 * These are the questions a database test cannot answer well: `yarn test:db`
 * can show that one scenario left one row behind, but not that a group of
 * four produces six pairs, that a driverless group records no driver, or that
 * each pairing is recorded exactly once across a sequence of departures. Those
 * are properties of the membership, so they are asserted here against a table
 * of memberships. `carpoolPairing.db.test.ts` covers the half this cannot:
 * that the write is inside the teardown transaction and survives the group's
 * deletion.
 */

const DRIVER = "user-driver";
const RIDER_1 = "user-rider-1";
const RIDER_2 = "user-rider-2";
const RIDER_3 = "user-rider-3";
const GROUP = "group-1";

const FORMED = new Date("2026-01-05T09:00:00.000Z");
const ENDED = new Date("2026-06-05T09:00:00.000Z");

const members = (...ids: string[]): PairingMember[] =>
  ids.map((userId) => ({
    userId,
    role: userId === DRIVER ? Role.DRIVER : Role.RIDER,
  }));

const build = (memberList: PairingMember[], departing: string | null = null) =>
  buildPairings({
    groupId: GROUP,
    members: memberList,
    departing,
    formedAt: FORMED,
    endedAt: ENDED,
  });

/** Each row as `a|b`, sorted, so a comparison does not depend on row order. */
const pairsOf = (rows: ReturnType<typeof build>) =>
  rows.map((row) => `${row.userAId}|${row.userBId}`).sort();

describe("buildPairings", () => {
  describe("dissolving a whole group", () => {
    it("records the one pair in a group of two", () => {
      expect(pairsOf(build(members(DRIVER, RIDER_1)))).toEqual([
        [DRIVER, RIDER_1].sort().join("|"),
      ]);
    });

    it("records every pair in the group, not only the driver's", () => {
      // The reason this matters is safety, not completeness: a rider who
      // wants to report the *other* rider after the carpool ends needs the
      // rider-to-rider row, and a driver-centred record would not have it.
      const rows = build(members(DRIVER, RIDER_1, RIDER_2));

      expect(rows).toHaveLength(3);
      expect(pairsOf(rows)).toEqual(
        [
          [DRIVER, RIDER_1].sort().join("|"),
          [DRIVER, RIDER_2].sort().join("|"),
          [RIDER_1, RIDER_2].sort().join("|"),
        ].sort(),
      );
    });

    it("records every unordered pair once in a group of four", () => {
      const rows = build(members(DRIVER, RIDER_1, RIDER_2, RIDER_3));

      // Four members is six pairs, and a duplicate or a self-pair would show
      // up as a different count.
      expect(rows).toHaveLength(6);
      expect(new Set(pairsOf(rows)).size).toBe(6);
      expect(rows.every((row) => row.userAId !== row.userBId)).toBe(true);
    });

    it("records nothing for a group of one", () => {
      expect(build(members(DRIVER))).toEqual([]);
    });

    it("records nothing for an empty membership", () => {
      expect(build([])).toEqual([]);
    });
  });

  describe("one member departing", () => {
    it("records the departing member against each other member", () => {
      const rows = build(members(DRIVER, RIDER_1, RIDER_2), RIDER_1);

      expect(pairsOf(rows)).toEqual(
        [
          [RIDER_1, DRIVER].sort().join("|"),
          [RIDER_1, RIDER_2].sort().join("|"),
        ].sort(),
      );
    });

    it("leaves the pairs that are still live alone", () => {
      const rows = build(members(DRIVER, RIDER_1, RIDER_2), RIDER_1);

      // The driver and the remaining rider are still carpooling, so their
      // pairing has not ended and must not be recorded as though it had.
      expect(pairsOf(rows)).not.toContain([DRIVER, RIDER_2].sort().join("|"));
    });

    it("records each pairing exactly once across a sequence of departures", () => {
      // The property the two cases have to satisfy together. A rider leaves a
      // group of three, then the remaining pair dissolves: between them that
      // is every pair, once.
      const first = build(members(DRIVER, RIDER_1, RIDER_2), RIDER_1);
      const then = build(members(DRIVER, RIDER_2));

      const all = [...pairsOf(first), ...pairsOf(then)].sort();

      expect(all).toEqual(
        [
          [DRIVER, RIDER_1].sort().join("|"),
          [RIDER_1, RIDER_2].sort().join("|"),
          [DRIVER, RIDER_2].sort().join("|"),
        ].sort(),
      );
      expect(new Set(all).size).toBe(all.length);
    });

    it("records nothing when the departing member is not in the membership", () => {
      // This is what a caller reading the membership *after* the detach looks
      // like. Pairing them with the whole group would invent rows.
      expect(build(members(DRIVER, RIDER_1), "user-outsider")).toEqual([]);
    });

    it("records nothing when the departing member is the only member", () => {
      expect(build(members(DRIVER), DRIVER)).toEqual([]);
    });
  });

  describe("the driver column", () => {
    it("records the member whose role is DRIVER", () => {
      const rows = build(members(DRIVER, RIDER_1, RIDER_2));

      expect(rows.every((row) => row.driverId === DRIVER)).toBe(true);
    });

    it("records no driver when the group had none", () => {
      // Driverless groups exist in production (SCRUM-406) and their riders
      // leave one at a time, so this is a real membership rather than a
      // hypothetical. Naming the first member would be a quiet lie.
      const driverless: PairingMember[] = [
        { userId: RIDER_1, role: Role.RIDER },
        { userId: RIDER_2, role: Role.RIDER },
      ];

      const rows = build(driverless);

      expect(rows).toHaveLength(1);
      expect(rows[0].driverId).toBeNull();
    });

    it("does not treat a VIEWER as a driver", () => {
      const rows = build([
        { userId: RIDER_1, role: Role.VIEWER },
        { userId: RIDER_2, role: Role.RIDER },
      ]);

      expect(rows[0].driverId).toBeNull();
    });
  });

  describe("the stored pair order", () => {
    it("puts the lexicographically smaller id in userAId", () => {
      const rows = build(members(DRIVER, RIDER_1));

      expect(rows[0].userAId < rows[0].userBId).toBe(true);
    });

    it("is the same whichever member is the one departing", () => {
      // The property that makes "did these two carpool" a single indexed
      // lookup: the row does not depend on who left first.
      const riderLeft = build(members(DRIVER, RIDER_1), RIDER_1);
      const driverLeft = build(members(DRIVER, RIDER_1), DRIVER);

      expect(pairsOf(riderLeft)).toEqual(pairsOf(driverLeft));
      // ...and the driver is still identified, by the column that means it.
      expect(riderLeft[0].driverId).toBe(DRIVER);
      expect(driverLeft[0].driverId).toBe(DRIVER);
    });
  });

  it("carries the group id and both timestamps onto every row", () => {
    const rows = build(members(DRIVER, RIDER_1, RIDER_2));

    for (const row of rows) {
      expect(row.groupId).toBe(GROUP);
      expect(row.formedAt).toBe(FORMED);
      expect(row.endedAt).toBe(ENDED);
    }
  });

  it("accepts a null formedAt", () => {
    // The group row can already be gone when a membership still pointing at
    // it is cleared. That is "not knowable", and the rest of the row is still
    // worth writing.
    const rows = buildPairings({
      groupId: GROUP,
      members: members(DRIVER, RIDER_1),
      departing: null,
      formedAt: null,
      endedAt: ENDED,
    });

    expect(rows[0].formedAt).toBeNull();
    expect(rows[0].endedAt).toBe(ENDED);
  });
});

describe("recordPairings", () => {
  const rowsFor = () => build(members(DRIVER, RIDER_1));

  const txWith = (createMany: jest.Mock) =>
    ({ carpoolPairing: { createMany } }) as unknown as TransactionClient;

  it("writes every row in one statement", async () => {
    // One statement per parting, so a dissolution cannot land half-recorded -
    // which a reader could not tell from a pair who never shared a group.
    const createMany = jest.fn(async () => ({ count: 1 }));

    await recordPairings(txWith(createMany), rowsFor());

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({ data: rowsFor() });
  });

  it("returns the number of rows written", async () => {
    const createMany = jest.fn(async () => ({ count: 3 }));

    await expect(recordPairings(txWith(createMany), rowsFor())).resolves.toBe(
      3,
    );
  });

  it("writes nothing at all when there are no rows", async () => {
    const createMany = jest.fn(async () => ({ count: 0 }));

    await expect(recordPairings(txWith(createMany), [])).resolves.toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  describe("when the write fails", () => {
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
      consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    it("does not throw, so the parting it is inside still commits", async () => {
      // The asymmetry this whole module exists to get right: a missing
      // pairing row is recoverable, a user trapped in a group they pressed
      // Leave on is not. `groups.ts` calls this inside the teardown
      // transaction, and Prisma rolls that transaction back only if the
      // callback throws - so not throwing here *is* the guarantee.
      const createMany = jest.fn(async () => {
        throw new Error("carpool_pairing is gone");
      });

      await expect(recordPairings(txWith(createMany), rowsFor())).resolves.toBe(
        0,
      );
    });

    it("logs the loss", async () => {
      const createMany = jest.fn(async () => {
        throw new Error("carpool_pairing is gone");
      });

      await recordPairings(txWith(createMany), rowsFor());

      expect(consoleError).toHaveBeenCalled();
    });

    it("swallows a delegate that is not there at all", async () => {
      // What an older generated client, or a database the migration has not
      // reached, actually looks like from here: a `TypeError` rather than a
      // Prisma error. Catching only Prisma's errors would turn that into a
      // failed departure.
      const tx = {} as unknown as TransactionClient;

      await expect(recordPairings(tx, rowsFor())).resolves.toBe(0);
    });
  });
});

describe("pairingRetentionCutoff", () => {
  it("is twelve months before the given moment", () => {
    expect(PAIRING_RETENTION_MONTHS).toBe(12);

    expect(
      pairingRetentionCutoff(new Date("2026-10-14T12:00:00.000Z")),
    ).toEqual(new Date("2025-10-14T12:00:00.000Z"));
  });

  it("lands on the same calendar day across a leap year", () => {
    // A millisecond count would be a day out here, and the row's lifetime
    // should not depend on which years it spanned.
    expect(
      pairingRetentionCutoff(new Date("2025-03-01T12:00:00.000Z")),
    ).toEqual(new Date("2024-03-01T12:00:00.000Z"));
  });

  it("does not mutate the date it is given", () => {
    const now = new Date("2026-10-14T12:00:00.000Z");

    pairingRetentionCutoff(now);

    expect(now.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });
});
