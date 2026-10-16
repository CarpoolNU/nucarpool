import type { TransactionClient } from "./client";
import {
  CONTACT_RETENTION_MONTHS,
  buildContact,
  contactRetentionCutoff,
  recordContact,
} from "./messageContact";

/**
 * The durable record that two users corresponded (SCRUM-676).
 *
 * The split this file pins is the same one `carpoolPairing.test.ts` pins for
 * the sibling record: {@link buildContact} decides *which* row a deletion
 * produces and is a pure function of two ids, so it is asserted here against a
 * table of cases rather than inferred from a database test that can only show
 * the end state of one scenario at a time. {@link recordContact} is the write,
 * and the property worth pinning about it is the one that keeps the exits
 * open — it cannot throw.
 *
 * The retention helpers are tested to the millisecond from both sides,
 * because the cutoff is the boundary two different callers have to agree on:
 * the reader retains `endedAt >= cutoff` and the sweep deletes
 * `endedAt < cutoff`. A drift of one millisecond between them would be a row
 * that is both listed and sweepable, or neither.
 */

const ALICE = "user-alice";
const BOB = "user-bob";
const ENDED_AT = new Date("2026-10-15T12:00:00.000Z");

describe("CONTACT_RETENTION_MONTHS", () => {
  it("is twelve months, matching the carpool pairing window", () => {
    // SCRUM-676 chose not to diverge from SCRUM-636 here. Two different
    // windows for two kinds of past connection would be hard to explain to a
    // user and harder to sweep correctly, so this is pinned rather than left
    // to drift the next time either is touched.
    expect(CONTACT_RETENTION_MONTHS).toBe(12);
  });
});

describe("contactRetentionCutoff", () => {
  it("lands on the same day of the month a year earlier", () => {
    expect(
      contactRetentionCutoff(new Date("2026-10-15T12:00:00.000Z")),
    ).toEqual(new Date("2025-10-15T12:00:00.000Z"));
  });

  it("keeps the time of day across a leap day", () => {
    // Month arithmetic rather than a millisecond count, so a row's lifetime
    // does not depend on which side of a leap day or a daylight-saving
    // transition it ended. `365 * 24 * 60 * 60 * 1000` would be a day out
    // here.
    expect(
      contactRetentionCutoff(new Date("2025-03-01T08:30:00.000Z")),
    ).toEqual(new Date("2024-03-01T08:30:00.000Z"));
  });

  it("does not mutate the date it is given", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");

    contactRetentionCutoff(now);

    expect(now).toEqual(new Date("2026-10-15T12:00:00.000Z"));
  });
});

describe("buildContact", () => {
  it("orders the pair canonically regardless of who deleted the request", () => {
    // The whole point of a canonical order: whichever party deletes, the two
    // ids land in the same columns, so the `@@unique` collapses them to one
    // row and a reader who knows the pair needs one lookup rather than two.
    const fromAlice = buildContact({
      fromUserId: ALICE,
      toUserId: BOB,
      endedAt: ENDED_AT,
    });
    const fromBob = buildContact({
      fromUserId: BOB,
      toUserId: ALICE,
      endedAt: ENDED_AT,
    });

    expect(fromAlice).toEqual(fromBob);
    expect(fromAlice).toEqual({
      userAId: ALICE,
      userBId: BOB,
      endedAt: ENDED_AT,
    });
  });

  it("produces nothing for a self-request", () => {
    // `requests.delete` exempts a self-request from its carpooling guard
    // because the comparison degenerates for one, and two of them exist in
    // production. Recording one here would pair a user with themselves, which
    // would then render in their own past-connections list as a row offering
    // to report and block themselves.
    expect(
      buildContact({ fromUserId: ALICE, toUserId: ALICE, endedAt: ENDED_AT }),
    ).toBeNull();
  });

  it("carries the deletion time through as endedAt", () => {
    const deletedAt = new Date("2027-01-02T03:04:05.678Z");

    expect(
      buildContact({ fromUserId: ALICE, toUserId: BOB, endedAt: deletedAt }),
    ).toMatchObject({ endedAt: deletedAt });
  });
});

describe("recordContact", () => {
  const row = { userAId: ALICE, userBId: BOB, endedAt: ENDED_AT };

  const txWith = (upsert: jest.Mock) =>
    ({ messageContact: { upsert } }) as unknown as TransactionClient;

  it("upserts on the pair, moving endedAt forward on a repeat", () => {
    // The upsert is what bounds the table at one row per pair. Creating and
    // deleting a request is cheap and repeatable, so an insert per delete
    // would let one pair write unbounded rows - the reason this record
    // diverges from `CarpoolPairing`, which inserts freely.
    const upsert = jest.fn(async () => ({}));

    return recordContact(txWith(upsert), row).then(() => {
      expect(upsert).toHaveBeenCalledWith({
        where: { userAId_userBId: { userAId: ALICE, userBId: BOB } },
        update: { endedAt: ENDED_AT },
        create: row,
      });
    });
  });

  it("writes nothing when there is no row to write", async () => {
    const upsert = jest.fn(async () => ({}));

    await expect(recordContact(txWith(upsert), null)).resolves.toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("reports a successful write", async () => {
    await expect(
      recordContact(txWith(jest.fn(async () => ({}))), row),
    ).resolves.toBe(true);
  });

  describe("when the write fails", () => {
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
      consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    it("does not throw, so the delete it runs inside still commits", async () => {
      // **This is the open-exits rule (SCRUM-554), held by the shape of the
      // code rather than by a promise about it.** Prisma rolls an interactive
      // transaction back when the callback throws, so a pairing write that
      // propagated its error would take `requests.delete` with it and strand
      // a user on a request they pressed delete on. A missing record is
      // recoverable; a user who cannot clear a request is not.
      const upsert = jest.fn(async () => {
        throw new Error("duplicate key");
      });

      await expect(recordContact(txWith(upsert), row)).resolves.toBe(false);
    });

    it("logs the loss rather than swallowing it silently", async () => {
      const upsert = jest.fn(async () => {
        throw new Error("duplicate key");
      });

      await recordContact(txWith(upsert), row);

      expect(consoleError).toHaveBeenCalled();
    });
  });
});
