import { Prisma, Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * The durable pairing record, against a real MySQL (SCRUM-636).
 *
 * `groups.test.ts` already pins which rows a parting produces, and
 * `src/server/db/carpoolPairing.test.ts` pins the builder itself. Neither can
 * settle the two properties this model exists for, because both run on a
 * mocked Prisma with no transactions and no referential behaviour:
 *
 *   - **The row outlives everything it describes.** The group is deleted in
 *     the same transaction that writes the pairing, and the request and the
 *     conversation go afterwards. Under `relationMode = "prisma"` a relation
 *     to any of them would have cascaded the pairing away with them — these
 *     tests are what shows the denormalised ids actually survive.
 *   - **The write is inside the teardown transaction, and cannot fail it.**
 *     Those pull in opposite directions and only a real transaction can show
 *     both: a failure elsewhere in the teardown must take the pairing with
 *     it, while a failure of the pairing insert itself must leave the rest
 *     committed. A mocked Prisma has no isolation level and no statement-level
 *     rollback, so it can assert neither.
 *
 * One test per teardown path, as the ticket asks: `groups.delete` dissolving
 * the whole group, and `groups.edit` parting one member — with and without the
 * dissolution that follows at two members.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`.
 */

const prisma = integrationPrisma();

const sessionFor = (id: string): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true },
  }) as unknown as Session;

const callerFor = (userId: string, client: typeof prisma = prisma) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: client,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

const seedLocation = async (streetAddress: string) =>
  prisma.location.create({
    data: {
      city: "Boston",
      state: "MA",
      street: streetAddress,
      streetAddress,
      coordLng: -71.05,
      coordLat: 42.36,
    },
  });

const seedUser = async (
  name: string,
  email: string,
  search: { role: Role; seatsAvail: number; carpoolId?: string | null },
) => {
  const user = await prisma.user.create({ data: { name, email } });
  const home = await seedLocation(`${email} home`);
  const company = await seedLocation(`${email} work`);
  const carpoolSearch = await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role: search.role,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: search.seatsAvail,
      carpoolId: search.carpoolId ?? null,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return { user, search: carpoolSearch };
};

/**
 * A driver in a group of their own.
 *
 * `formedAt` on the pairing is read from this row's `dateCreated`, so the
 * group is created with an explicit one — far enough in the past that a test
 * asserting the pairing carries it cannot pass by accidentally picking up
 * `now()` from somewhere else.
 */
const FORMED_AT = new Date("2026-02-03T08:30:00.000Z");

const seedGroupedDriver = async (
  name: string,
  email: string,
  seatsAvail: number,
) => {
  const driver = await seedUser(name, email, { role: Role.DRIVER, seatsAvail });
  const group = await prisma.carpoolGroup.create({
    data: { dateCreated: FORMED_AT },
  });
  await prisma.carpoolSearch.update({
    where: { id: driver.search.id },
    data: { carpoolId: group.id },
  });
  return { ...driver, group };
};

const seedRider = (
  name: string,
  email: string,
  carpoolId: string | null = null,
) => seedUser(name, email, { role: Role.RIDER, seatsAvail: 0, carpoolId });

/**
 * An accepted request with a conversation and a message, the way a real
 * pairing arrives — and the three rows that are all gone by the time anything
 * reads the pairing.
 */
const seedAcceptedRequestWithConversation = async (
  fromUserId: string,
  toUserId: string,
) => {
  const request = await prisma.request.create({
    data: {
      message: "Want to carpool?",
      fromUserId,
      toUserId,
      status: RequestStatus.ACCEPTED,
    },
  });
  const conversation = await prisma.conversation.create({
    data: { requestId: request.id },
  });
  await prisma.request.update({
    where: { id: request.id },
    data: { conversationId: conversation.id },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: fromUserId,
      content: "See you at 8.",
    },
  });
  return { request, conversation };
};

const pairingsOf = (userId: string) =>
  prisma.carpoolPairing.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { endedAt: "asc" },
  });

const allPairings = () => prisma.carpoolPairing.findMany({});

/** The two ids as the schema stores them: smaller first. */
const orderedPair = (a: string, b: string) => [a, b].sort();

/**
 * A client whose interactive transactions hand the procedure a `tx` that
 * fails one statement.
 *
 * Forcing the failure rather than contriving a database state to produce it:
 * the point is what the surrounding transaction does when one write inside it
 * fails, and nothing about *why* it failed changes that. `buildDelayedClient`
 * in `seatAccountingRace.db.test.ts` is the same technique aimed at ordering
 * instead of failure.
 *
 * `failPairingWrite` fails the pairing insert, which must leave the teardown
 * committed. `failRawMatching` fails one of the teardown's own raw statements
 * *after* the pairing write, which must take the pairing down with it. The two
 * together are the whole asymmetry.
 */
const buildFailingClient = (
  client: typeof prisma,
  options: { failPairingWrite?: boolean; failRawMatching?: string },
) =>
  new Proxy(client, {
    get(target, property) {
      if (property !== "$transaction") {
        return Reflect.get(target, property);
      }
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          const failingTx = new Proxy(tx, {
            get(txTarget, txProperty) {
              if (options.failPairingWrite && txProperty === "carpoolPairing") {
                return {
                  createMany: async () => {
                    throw new Error("carpool_pairing is unreachable");
                  },
                };
              }
              if (options.failRawMatching && txProperty === "$executeRaw") {
                return (strings: unknown, ...values: unknown[]) => {
                  const sql = (strings as string[]).join("?");
                  if (sql.includes(options.failRawMatching!)) {
                    throw new Error("the teardown's own write failed");
                  }
                  return (
                    txTarget.$executeRaw as unknown as (
                      s: unknown,
                      ...v: unknown[]
                    ) => Promise<number>
                  )(strings, ...values);
                };
              }
              return Reflect.get(txTarget, txProperty);
            },
          });
          return fn(failingTx as Prisma.TransactionClient);
        });
    },
  }) as typeof client;

describe("groups.delete — dissolving the whole group", () => {
  it("leaves a pairing that outlives the group, the request and the conversation", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dee",
      "pairing-driver-dee@northeastern.edu",
      1,
    );
    const rider = await seedRider(
      "Rider Ray",
      "pairing-rider-ray@northeastern.edu",
      driver.group.id,
    );
    const { request, conversation } = await seedAcceptedRequestWithConversation(
      rider.user.id,
      driver.user.id,
    );

    await callerFor(driver.user.id).user.groups.delete({
      groupId: driver.group.id,
    });

    // Now erase what used to be the only evidence, exactly as the app allows
    // once the pair has parted: either party may delete the accepted request,
    // and that takes the conversation and its messages with it.
    await callerFor(rider.user.id).user.requests.delete({
      invitationId: request.id,
    });

    expect(
      await prisma.carpoolGroup.findUnique({ where: { id: driver.group.id } }),
    ).toBeNull();
    expect(
      await prisma.request.findUnique({ where: { id: request.id } }),
    ).toBeNull();
    expect(
      await prisma.conversation.findUnique({ where: { id: conversation.id } }),
    ).toBeNull();

    // The point of the model: the group, the request and the conversation are
    // all gone, and the record that these two carpooled is not.
    const rows = await allPairings();
    expect(rows).toHaveLength(1);
    expect([rows[0].userAId, rows[0].userBId]).toEqual(
      orderedPair(driver.user.id, rider.user.id),
    );
    expect(rows[0].driverId).toBe(driver.user.id);
    expect(rows[0].groupId).toBe(driver.group.id);
    expect(rows[0].formedAt).toEqual(FORMED_AT);
    expect(rows[0].endedAt.getTime()).toBeGreaterThan(FORMED_AT.getTime());
  });

  it("records every pair in a group of three", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dot",
      "pairing-driver-dot@northeastern.edu",
      2,
    );
    const first = await seedRider(
      "Rider Ren",
      "pairing-rider-ren@northeastern.edu",
      driver.group.id,
    );
    const second = await seedRider(
      "Rider Rue",
      "pairing-rider-rue@northeastern.edu",
      driver.group.id,
    );

    await callerFor(driver.user.id).user.groups.delete({
      groupId: driver.group.id,
    });

    const rows = await allPairings();
    expect(rows).toHaveLength(3);
    // Including the rider-to-rider pair, which is the one a driver-centred
    // record would miss and the one a rider reporting the *other* rider needs.
    expect(
      rows.map((row) => [row.userAId, row.userBId].join("|")).sort(),
    ).toEqual(
      [
        orderedPair(driver.user.id, first.user.id).join("|"),
        orderedPair(driver.user.id, second.user.id).join("|"),
        orderedPair(first.user.id, second.user.id).join("|"),
      ].sort(),
    );
    // One dissolution, one pairing identifier across its rows.
    expect(new Set(rows.map((row) => row.groupId)).size).toBe(1);
  });

  it("records no driver for a driverless group", async () => {
    // Driverless groups exist in production (SCRUM-406). `delete` needs a
    // driver to authorize it, so this one is dissolved through the path its
    // riders actually have - leaving one at a time - and the assertion is
    // about the column, not the route.
    const group = await prisma.carpoolGroup.create({
      data: { dateCreated: FORMED_AT },
    });
    const first = await seedRider(
      "Rider Rae",
      "pairing-driverless-rae@northeastern.edu",
      group.id,
    );
    const second = await seedRider(
      "Rider Rob",
      "pairing-driverless-rob@northeastern.edu",
      group.id,
    );

    await callerFor(first.user.id).user.groups.edit({
      driverId: first.user.id,
      riderId: first.user.id,
      groupId: group.id,
      add: false,
    });

    const rows = await allPairings();
    expect(rows).toHaveLength(1);
    expect(rows[0].driverId).toBeNull();
    expect([rows[0].userAId, rows[0].userBId]).toEqual(
      orderedPair(first.user.id, second.user.id),
    );
  });
});

describe("groups.edit — one member parting", () => {
  it("records the pair when the group dissolves on the way out", async () => {
    // The second teardown path: at two members, a departure dissolves the
    // group. The row is written from the departure, and the dissolution that
    // follows adds nothing - a group of one has no pair left to end.
    const driver = await seedGroupedDriver(
      "Driver Dan",
      "pairing-driver-dan@northeastern.edu",
      1,
    );
    const rider = await seedRider(
      "Rider Rio",
      "pairing-rider-rio@northeastern.edu",
      driver.group.id,
    );

    const result = await callerFor(rider.user.id).user.groups.edit({
      driverId: driver.user.id,
      riderId: rider.user.id,
      groupId: driver.group.id,
      add: false,
    });

    expect(result).toBeNull();
    expect(
      await prisma.carpoolGroup.findUnique({ where: { id: driver.group.id } }),
    ).toBeNull();

    const rows = await allPairings();
    expect(rows).toHaveLength(1);
    expect([rows[0].userAId, rows[0].userBId]).toEqual(
      orderedPair(driver.user.id, rider.user.id),
    );
    expect(rows[0].driverId).toBe(driver.user.id);
    expect(rows[0].formedAt).toEqual(FORMED_AT);
  });

  it("records a departure from a group that survives it, and only that member's pairs", async () => {
    const driver = await seedGroupedDriver(
      "Driver Deb",
      "pairing-driver-deb@northeastern.edu",
      2,
    );
    const leaving = await seedRider(
      "Rider Rex",
      "pairing-rider-rex@northeastern.edu",
      driver.group.id,
    );
    const staying = await seedRider(
      "Rider Rod",
      "pairing-rider-rod@northeastern.edu",
      driver.group.id,
    );

    await callerFor(leaving.user.id).user.groups.edit({
      driverId: driver.user.id,
      riderId: leaving.user.id,
      groupId: driver.group.id,
      add: false,
    });

    // The group is still there, so the pair left inside it has not parted.
    expect(
      await prisma.carpoolGroup.findUnique({ where: { id: driver.group.id } }),
    ).not.toBeNull();

    const rows = await allPairings();
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => [row.userAId, row.userBId].join("|")).sort(),
    ).toEqual(
      [
        orderedPair(leaving.user.id, driver.user.id).join("|"),
        orderedPair(leaving.user.id, staying.user.id).join("|"),
      ].sort(),
    );
    expect(await pairingsOf(staying.user.id)).toHaveLength(1);
  });

  it("records each pair exactly once across a departure and the dissolution after it", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dex",
      "pairing-driver-dex@northeastern.edu",
      2,
    );
    const first = await seedRider(
      "Rider Rem",
      "pairing-rider-rem@northeastern.edu",
      driver.group.id,
    );
    const second = await seedRider(
      "Rider Roy",
      "pairing-rider-roy@northeastern.edu",
      driver.group.id,
    );

    await callerFor(first.user.id).user.groups.edit({
      driverId: driver.user.id,
      riderId: first.user.id,
      groupId: driver.group.id,
      add: false,
    });
    await callerFor(second.user.id).user.groups.edit({
      driverId: driver.user.id,
      riderId: second.user.id,
      groupId: driver.group.id,
      add: false,
    });

    const rows = await allPairings();
    expect(rows).toHaveLength(3);
    expect(
      new Set(rows.map((row) => [row.userAId, row.userBId].join("|"))).size,
    ).toBe(3);
  });

  it("records nothing when the removal is refused", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dia",
      "pairing-driver-dia@northeastern.edu",
      2,
    );
    const rider = await seedRider(
      "Rider Rye",
      "pairing-rider-rye@northeastern.edu",
      driver.group.id,
    );
    const other = await seedRider(
      "Rider Raj",
      "pairing-rider-raj@northeastern.edu",
      driver.group.id,
    );

    // One rider cannot evict another.
    await expect(
      callerFor(rider.user.id).user.groups.edit({
        driverId: driver.user.id,
        riderId: other.user.id,
        groupId: driver.group.id,
        add: false,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await allPairings()).toEqual([]);
  });
});

describe("the write is inside the teardown transaction", () => {
  it("rolls the pairing back when a later statement in the teardown fails", async () => {
    // The pairing write happens before the seat credit on this path, so
    // failing the credit proves the insert is genuinely inside the
    // transaction rather than merely adjacent to it. `GREATEST(0, LEAST(` is
    // `releaseSeats`, the only statement doing clamped arithmetic.
    const driver = await seedGroupedDriver(
      "Driver Dov",
      "pairing-driver-dov@northeastern.edu",
      2,
    );
    const leaving = await seedRider(
      "Rider Ros",
      "pairing-rider-ros@northeastern.edu",
      driver.group.id,
    );
    await seedRider(
      "Rider Ric",
      "pairing-rider-ric@northeastern.edu",
      driver.group.id,
    );

    const failing = buildFailingClient(prisma, {
      failRawMatching: "GREATEST(0, LEAST(",
    });

    await expect(
      callerFor(leaving.user.id, failing).user.groups.edit({
        driverId: driver.user.id,
        riderId: leaving.user.id,
        groupId: driver.group.id,
        add: false,
      }),
    ).rejects.toThrow();

    // Everything rolled back together: the rider is still in the group, and
    // there is no pairing claiming they left it.
    expect(
      (
        await prisma.carpoolSearch.findFirst({
          where: { userId: leaving.user.id },
        })
      )?.carpoolId,
    ).toBe(driver.group.id);
    expect(await allPairings()).toEqual([]);
  });
});

describe("the pairing write cannot fail the parting", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("lets a rider out of the group even when the insert fails", async () => {
    // The decision this exists to prove, in the only place it can be proved:
    // InnoDB rolls back the failed statement, not the transaction, so the
    // detach and the seat credit still commit. A rollback here would leave a
    // user trapped in a group they pressed Leave on, which SCRUM-554
    // established is the one outcome worse than a missing record.
    const driver = await seedGroupedDriver(
      "Driver Dru",
      "pairing-driver-dru@northeastern.edu",
      1,
    );
    const rider = await seedRider(
      "Rider Rib",
      "pairing-rider-rib@northeastern.edu",
      driver.group.id,
    );

    const failing = buildFailingClient(prisma, { failPairingWrite: true });

    await expect(
      callerFor(rider.user.id, failing).user.groups.edit({
        driverId: driver.user.id,
        riderId: rider.user.id,
        groupId: driver.group.id,
        add: false,
      }),
    ).resolves.toBeNull();

    expect(
      (
        await prisma.carpoolSearch.findFirst({
          where: { userId: rider.user.id },
        })
      )?.carpoolId,
    ).toBeNull();
    expect(
      await prisma.carpoolGroup.findUnique({ where: { id: driver.group.id } }),
    ).toBeNull();
    expect(await allPairings()).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
  });

  it("lets the driver dissolve the group, and keeps the seat credit, even when the insert fails", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dax",
      "pairing-driver-dax@northeastern.edu",
      0,
    );
    await seedRider(
      "Rider Rin",
      "pairing-rider-rin@northeastern.edu",
      driver.group.id,
    );

    const failing = buildFailingClient(prisma, { failPairingWrite: true });

    await expect(
      callerFor(driver.user.id, failing).user.groups.delete({
        groupId: driver.group.id,
      }),
    ).resolves.toBeDefined();

    expect(
      await prisma.carpoolGroup.findUnique({ where: { id: driver.group.id } }),
    ).toBeNull();
    // The seat credit is in the same transaction as the failed insert. If the
    // swallow did not actually leave the transaction committable, this would
    // still be 0.
    expect(
      (
        await prisma.carpoolSearch.findFirst({
          where: { userId: driver.user.id },
        })
      )?.seatsAvail,
    ).toBe(1);
    expect(await allPairings()).toEqual([]);
  });
});
