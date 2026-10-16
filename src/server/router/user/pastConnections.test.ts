import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "../index";
import type { Context } from "../context";
import { pairingRetentionCutoff } from "../../db/carpoolPairing";
import { contactRetentionCutoff } from "../../db/messageContact";

/**
 * `user.pastConnections.me` - the people the caller used to carpool with.
 *
 * The list exists so that report and block can be reached after a connection
 * has ended (SCRUM-623). Everything it describes was already deleted by the
 * time it is read: the group, the `carpoolId`, the `ACCEPTED` request and the
 * conversation. `CarpoolPairing` is the only row left, and SCRUM-636 wrote it.
 *
 * What this file pins:
 *
 *   - the caller is the session, and the counterpart is whichever of the two
 *     denormalised columns is not them;
 *   - the retention window is applied in the query, not after it;
 *   - one counterpart is one row, however many times the two carpooled;
 *   - a counterpart whose account is gone is dropped rather than rendered;
 *   - the payload carries a name and a date and nothing else.
 *
 * The fake applies `where` and `orderBy` to an in-memory list rather than only
 * recording the arguments, so these assert the rows a caller receives. The
 * retention filter in particular has to be *applied* for its test to mean
 * anything - a fake that ignored `endedAt` would let an unfiltered query pass.
 */

const ME = "user-me";
const THEM = "user-them";
const OTHER = "user-other";

type PairingRow = {
  id: string;
  groupId: string;
  userAId: string;
  userBId: string;
  driverId: string | null;
  formedAt: Date | null;
  endedAt: Date;
};

/** A `MessageContact` row. No group, no driver: see `schema.prisma`. */
type ContactRow = {
  id: string;
  userAId: string;
  userBId: string;
  endedAt: Date;
};

type UserRow = { preferredName: string; name: string | null };

/**
 * One fake delegate, serving both tables.
 *
 * The two reads are the same query against two tables — the caller in either
 * user column, inside the retention window, newest first — so they share a
 * fake deliberately. Two independently written mocks would each be forgiving
 * in their own way, and a divergence between the two queries is exactly what
 * this file needs to be able to see.
 *
 * `expectedOrderBy` is passed in rather than assumed because the two tables
 * tie-break differently: `CarpoolPairing` needs `id` to make "most recent
 * first" total across the several rows one dissolution writes, while
 * `MessageContact` holds one row per pair and needs no tie-break at all.
 */
const buildRowFinder = <Row extends { endedAt: Date }>(
  rows: Row[],
  expectedOrderBy: unknown,
) =>
  jest.fn(async ({ where, orderBy, select }: any) => {
    const matchesCaller = (row: Row) =>
      where.OR.some(
        (clause: { userAId?: string; userBId?: string }) =>
          (clause.userAId !== undefined &&
            clause.userAId === (row as any).userAId) ||
          (clause.userBId !== undefined &&
            clause.userBId === (row as any).userBId),
      );

    // The retention filter is applied, not ignored: see the file comment.
    const insideWindow = (row: Row) =>
      where.endedAt?.gte === undefined ||
      row.endedAt.getTime() >= where.endedAt.gte.getTime();

    const matched = rows.filter(
      (row) => matchesCaller(row) && insideWindow(row),
    );

    // A different `orderBy` would silently come back unsorted, which is why
    // the shape is asserted rather than assumed.
    expect(orderBy).toEqual(expectedOrderBy);
    matched.sort(
      (a, b) =>
        b.endedAt.getTime() - a.endedAt.getTime() ||
        String((b as any).id ?? "").localeCompare(String((a as any).id ?? "")),
    );

    // Prisma returns only selected columns. Honouring that is what lets a
    // test prove the procedure never had `driverId` to leak in the first
    // place, rather than merely choosing not to return it.
    return matched.map((row) =>
      Object.fromEntries(
        Object.keys(select ?? row)
          .filter((key) => (select ? select[key] : true))
          .map((key) => [key, row[key as keyof Row]]),
      ),
    );
  });

const buildPairingsDb = (opts?: {
  rows?: PairingRow[];
  contacts?: ContactRow[];
  users?: Record<string, UserRow>;
}) => {
  const rows: PairingRow[] = opts?.rows ?? [];
  const contacts: ContactRow[] = opts?.contacts ?? [];
  const users: Record<string, UserRow> = opts?.users ?? {
    [ME]: { preferredName: "Me", name: "Me Full" },
    [THEM]: { preferredName: "Them", name: "Them Full" },
    [OTHER]: { preferredName: "", name: "Other Full" },
  };

  const findMany = buildRowFinder(rows, [{ endedAt: "desc" }, { id: "desc" }]);

  // No `id` tie-break: the `@@unique([userAId, userBId])` means one row per
  // pair, so `endedAt` alone is already a total order over a caller's rows.
  const contactFindMany = buildRowFinder(contacts, [{ endedAt: "desc" }]);

  const client = {
    carpoolPairing: { findMany },
    messageContact: { findMany: contactFindMany },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        (where.id.in as string[])
          .filter((id) => id in users)
          .map((id) => ({ id, ...users[id] })),
      ),
    },
  };

  return { prisma: client, findMany, contactFindMany };
};

/** A contact that ended recently enough to always be inside the window. */
const contact = (
  id: string,
  userAId: string,
  userBId: string,
  endedAt: Date,
): ContactRow => ({ id, userAId, userBId, endedAt });

const sessionFor = (id: string): Session => ({
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id,
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
});

const callerFor = (
  session: Session | null,
  db: ReturnType<typeof buildPairingsDb> = buildPairingsDb(),
) => {
  const ctx = {
    req: undefined,
    res: undefined,
    session,
    prisma: db.prisma,
    sesClient: { send: jest.fn() },
  } as unknown as Context;

  return { caller: appRouter.createCaller(ctx), db };
};

/** A pairing that ended recently enough to always be inside the window. */
const pairing = (
  id: string,
  userAId: string,
  userBId: string,
  endedAt: Date,
): PairingRow => ({
  id,
  groupId: `group-${id}`,
  userAId,
  userBId,
  driverId: userAId,
  formedAt: new Date("2026-01-01T00:00:00.000Z"),
  endedAt,
});

/**
 * Fixed instants rather than a `daysAgo()` helper called per use.
 *
 * A helper reading `Date.now()` at each call site returns a slightly
 * different millisecond in the row and in the assertion, so an equality
 * check on `endedAt` would fail intermittently on timing alone. These are
 * computed once, at module load, and compared by reference.
 */
const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
const TWENTY_DAYS_AGO = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);

describe("user.pastConnections.me", () => {
  it("resolves the counterpart from whichever column is not the caller", async () => {
    // The schema stores the pair in a canonical order, so the caller is
    // `userAId` on some of their own rows and `userBId` on others. Both are
    // the same person's history and both have to come back.
    const db = buildPairingsDb({
      rows: [
        pairing("p1", ME, THEM, TEN_DAYS_AGO),
        pairing("p2", OTHER, ME, TWENTY_DAYS_AGO),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: TEN_DAYS_AGO, kind: "CARPOOLED" },
      {
        userId: OTHER,
        name: "Other Full",
        endedAt: TWENTY_DAYS_AGO,
        kind: "CARPOOLED",
      },
    ]);
  });
});

/**
 * Scoping and disclosure.
 *
 * These passed the first time they were run: the `where` clause and the
 * `select` that satisfy them were both written to pass the tests above, and
 * neither needed its own red step. They are kept as regression guards,
 * because the two things they pin are the two that would matter most if a
 * later edit lost them - whose rows a caller can read, and how much of each
 * row crosses the wire.
 */
describe("user.pastConnections.me scoping", () => {
  it("does not return a pairing between two other users", async () => {
    const db = buildPairingsDb({
      rows: [pairing("p1", THEM, OTHER, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([]);
  });

  it("scopes to the session user, not to anything in the input", async () => {
    // There is no input at all, which is the point: `me` takes none, so there
    // is no field a client could use to name a different reader. The caller
    // identity comes from `ctx.session` and nowhere else.
    const db = buildPairingsDb({
      rows: [
        pairing("p1", ME, THEM, TEN_DAYS_AGO),
        pairing("p2", THEM, OTHER, TWENTY_DAYS_AGO),
      ],
    });
    const { caller } = callerFor(sessionFor(THEM), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: ME, name: "Me", endedAt: TEN_DAYS_AGO, kind: "CARPOOLED" },
      {
        userId: OTHER,
        name: "Other Full",
        endedAt: TWENTY_DAYS_AGO,
        kind: "CARPOOLED",
      },
    ]);
  });

  it("rejects a caller with no session", async () => {
    const { caller } = callerFor(null);

    await expect(caller.user.pastConnections.me()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns only a name and an end date for each counterpart", async () => {
    // The visibility position recorded on SCRUM-623: a display name and when
    // the pairing ended, and nothing else. `driverId`, `formedAt` and
    // `groupId` are all on the row and none of them is the reader's to be
    // handed back - the driver's identity least of all.
    //
    // The fake honours `select`, so this also shows the columns are never
    // fetched, rather than fetched and then discarded.
    const db = buildPairingsDb({
      rows: [pairing("p1", ME, THEM, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const result = await caller.user.pastConnections.me();

    expect(Object.keys(result[0]).sort()).toEqual([
      "endedAt",
      "kind",
      "name",
      "userId",
    ]);
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { userAId: true, userBId: true, endedAt: true },
      }),
    );
  });
});

describe("user.pastConnections.me missing counterparts", () => {
  it("drops a pairing whose counterpart no longer has an account", async () => {
    // `CarpoolPairing`'s user ids are plain columns, not relations - SCRUM-636
    // made them so deliberately, because a relation would have cascaded the
    // row away with the group it describes. The cost is that an id here can
    // outlive the user it names.
    //
    // Such a row is dropped rather than rendered as "Unknown user", because
    // both actions the row exists to offer would fail on it: `reports.create`
    // and `applyBlock` each look the target up and throw NOT_FOUND. A row
    // whose every control is broken is worse than no row.
    const db = buildPairingsDb({
      rows: [
        pairing("p1", ME, THEM, TEN_DAYS_AGO),
        pairing("p2", ME, "user-deleted", TWENTY_DAYS_AGO),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: TEN_DAYS_AGO, kind: "CARPOOLED" },
    ]);
  });
});

describe("user.pastConnections.me deduplication", () => {
  it("returns one row per counterpart, carrying the most recent pairing", async () => {
    // The same two people can carpool, part, and carpool again - and a
    // dissolution of a group of three writes a row per pair, so a counterpart
    // can also appear across separate partings. Either way the reader wants
    // one person, once: a list repeating a name is unreadable, and two
    // adjacent rows offering Report for the same person is worse.
    //
    // Rows arrive newest first, so the first one seen for a counterpart is
    // the most recent by construction.
    const db = buildPairingsDb({
      rows: [
        pairing("p1", ME, THEM, TWENTY_DAYS_AGO),
        pairing("p2", THEM, ME, TEN_DAYS_AGO),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: TEN_DAYS_AGO, kind: "CARPOOLED" },
    ]);
  });
});

/**
 * The retention window, on a frozen clock.
 *
 * Frozen because the boundary is the point: the procedure computes its own
 * cutoff from `new Date()`, so on a live clock a row placed "exactly at the
 * cutoff" by the test is already a few milliseconds outside the one the
 * procedure computes a moment later, and the assertion would be measuring the
 * gap between two `Date.now()` calls rather than the rule.
 *
 * **These two tests are what pins this list against
 * `scripts/expire-carpool-pairings.ts`.** That sweep deletes `endedAt <
 * cutoff`; this list returns `endedAt >= cutoff`. The boundary row belongs to
 * exactly one of them, and these assert which - so a later edit that made the
 * list `>` or the sweep `<=` would leave a row either listed and sweepable or
 * neither, and one of the two suites would say so.
 */
describe("user.pastConnections.me retention window", () => {
  const NOW = new Date("2026-10-15T12:00:00.000Z");

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns a pairing that ended exactly on the cutoff", async () => {
    const cutoff = pairingRetentionCutoff(NOW);
    const db = buildPairingsDb({ rows: [pairing("p1", ME, THEM, cutoff)] });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: cutoff, kind: "CARPOOLED" },
    ]);
  });

  it("omits a pairing that ended one millisecond before the cutoff", async () => {
    // The row the sweep is entitled to delete. The list must not show a
    // person whose record is already gone, or on its way.
    const cutoff = pairingRetentionCutoff(NOW);
    const justOutside = new Date(cutoff.getTime() - 1);
    const db = buildPairingsDb({
      rows: [pairing("p1", ME, THEM, justOutside)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([]);
  });

  it("returns a contact that ended exactly on its own cutoff", async () => {
    // The same boundary, against `scripts/expire-message-contacts.ts`. The
    // two records keep separate constants on purpose - SCRUM-676 chose the
    // same twelve months as SCRUM-636 rather than importing it, so that
    // shortening one window cannot silently shorten the other - and this is
    // the assertion that would notice if they diverged.
    const cutoff = contactRetentionCutoff(NOW);
    const db = buildPairingsDb({ contacts: [contact("c1", ME, THEM, cutoff)] });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: cutoff, kind: "MESSAGED" },
    ]);
  });

  it("omits a contact that ended one millisecond before its cutoff", async () => {
    const cutoff = contactRetentionCutoff(NOW);
    const db = buildPairingsDb({
      contacts: [contact("c1", ME, THEM, new Date(cutoff.getTime() - 1))],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([]);
  });
});

/**
 * The messaged-only half (SCRUM-676).
 *
 * A pair who exchanged a request and messages, never carpooled, and whose
 * request was then deleted by either party. `requests.delete` took the
 * conversation and every message with it, and no `CarpoolPairing` row exists
 * because they never shared a group — so before this record there was no
 * `userId` for `reports.create` or `blocks.block` to receive, and the person
 * who sent the messages could make themselves unreportable by deleting the
 * request.
 */
describe("user.pastConnections.me — people the caller only messaged", () => {
  it("lists a counterpart whose request was deleted", async () => {
    const db = buildPairingsDb({
      contacts: [contact("c1", ME, THEM, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: TEN_DAYS_AGO, kind: "MESSAGED" },
    ]);
  });

  it("resolves the counterpart from whichever column is not the caller", async () => {
    const db = buildPairingsDb({
      contacts: [
        contact("c1", ME, THEM, TEN_DAYS_AGO),
        contact("c2", OTHER, ME, TWENTY_DAYS_AGO),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: TEN_DAYS_AGO, kind: "MESSAGED" },
      {
        userId: OTHER,
        name: "Other Full",
        endedAt: TWENTY_DAYS_AGO,
        kind: "MESSAGED",
      },
    ]);
  });

  it("does not return a contact between two other users", async () => {
    const db = buildPairingsDb({
      contacts: [contact("c1", THEM, OTHER, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([]);
  });

  it("drops a contact whose counterpart no longer has an account", async () => {
    // Same reasoning as the pairing half: the ids are plain columns, and a
    // row whose Report and Block would both throw NOT_FOUND is worse than no
    // row.
    const db = buildPairingsDb({
      contacts: [
        contact("c1", ME, THEM, TEN_DAYS_AGO),
        contact("c2", ME, "user-deleted", TWENTY_DAYS_AGO),
      ],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      { userId: THEM, name: "Them", endedAt: TEN_DAYS_AGO, kind: "MESSAGED" },
    ]);
  });

  it("fetches only the three columns it returns", async () => {
    const db = buildPairingsDb({
      contacts: [contact("c1", ME, THEM, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.pastConnections.me();

    expect(db.contactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { userAId: true, userBId: true, endedAt: true },
      }),
    );
  });
});

/**
 * Merging the two records into one list.
 *
 * The merge happens here rather than in `PastConnectionsSection` so that the
 * rule below has one home and can be asserted without rendering anything. The
 * component gets one query, one loading state and one error state.
 */
describe("user.pastConnections.me — merging the two records", () => {
  it("interleaves both kinds by recency", async () => {
    const db = buildPairingsDb({
      rows: [pairing("p1", ME, THEM, TWENTY_DAYS_AGO)],
      contacts: [contact("c1", ME, OTHER, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      {
        userId: OTHER,
        name: "Other Full",
        endedAt: TEN_DAYS_AGO,
        kind: "MESSAGED",
      },
      {
        userId: THEM,
        name: "Them",
        endedAt: TWENTY_DAYS_AGO,
        kind: "CARPOOLED",
      },
    ]);
  });

  it("keeps the carpool entry when a counterpart appears in both", async () => {
    // **Carpooled wins regardless of which is more recent**, and the date
    // shown is the carpool's.
    //
    // Two people who messaged and then carpooled are, to the reader, people
    // they carpooled with; showing them as "Messaged until" because the
    // request happened to be deleted afterwards would be a worse description
    // of the same relationship. Picking by recency instead would make the
    // label flip the day either party cleared an old request, which is a
    // change in what the row claims caused by something the reader did not
    // do.
    const db = buildPairingsDb({
      rows: [pairing("p1", ME, THEM, TWENTY_DAYS_AGO)],
      contacts: [contact("c1", ME, THEM, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await expect(caller.user.pastConnections.me()).resolves.toEqual([
      {
        userId: THEM,
        name: "Them",
        endedAt: TWENTY_DAYS_AGO,
        kind: "CARPOOLED",
      },
    ]);
  });

  it("returns one entry per counterpart, never two", async () => {
    const db = buildPairingsDb({
      rows: [pairing("p1", ME, THEM, TEN_DAYS_AGO)],
      contacts: [contact("c1", THEM, ME, TEN_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    const result = await caller.user.pastConnections.me();

    expect(result).toHaveLength(1);
  });

  it("returns an empty list when neither record holds anything", async () => {
    const { caller } = callerFor(sessionFor(ME));

    await expect(caller.user.pastConnections.me()).resolves.toEqual([]);
  });

  it("looks each counterpart up once, not once per record", async () => {
    // One `user.findMany` for the merged set of ids. Resolving names per
    // record would be two queries, and would resolve a counterpart in both
    // records twice.
    const db = buildPairingsDb({
      rows: [pairing("p1", ME, THEM, TEN_DAYS_AGO)],
      contacts: [contact("c1", ME, OTHER, TWENTY_DAYS_AGO)],
    });
    const { caller } = callerFor(sessionFor(ME), db);

    await caller.user.pastConnections.me();

    expect(db.prisma.user.findMany).toHaveBeenCalledTimes(1);
  });
});
