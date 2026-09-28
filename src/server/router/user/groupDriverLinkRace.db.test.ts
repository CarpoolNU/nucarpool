import { Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * Two of a driver's pending requests accepted at nearly the same instant must
 * never both link the driver into a group.
 *
 * `reserveSeat` is correctly CAS'd, so a driver with 2+ open seats lets both
 * concurrent `groups.create` calls past it - each reserves its own seat,
 * creates its own `CarpoolGroup`, and links "its" rider via the guarded raw
 * `UPDATE`. Only the driver's own link
 * (`groups.ts`, just above the rider link) used a plain `carpoolSearch.updateMany`
 * with no `carpoolId IS NULL` guard and no check on the write count, so
 * whichever transaction committed last simply overwrote the other's work,
 * leaving one `CarpoolGroup` with a real rider and no driver. The mocked
 * suite (`groups.test.ts`) cannot reproduce that at all - a mocked Prisma has
 * no isolation level - so this needs a real MySQL.
 *
 * Like `groupSeatRace.db.test.ts`, no forced-interleaving barrier
 * is needed: `groups.create` opens its own interactive transaction per call,
 * and the several round trips between the membership checks and the commit
 * are ample window for a plain `Promise.all` to start both transactions
 * before either commits.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`.
 */

const prisma = integrationPrisma();

const sessionFor = (id: string): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true },
  }) as unknown as Session;

const callerFor = (userId: string) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma,
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

/** A driver with two open seats, not yet in any group. */
const seedDriver = async () => {
  const user = await prisma.user.create({
    data: { name: "Driver Dan", email: "driver-dan@northeastern.edu" },
  });
  const home = await seedLocation("12 Elm St");
  const company = await seedLocation("1 Congress St");
  await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role: Role.DRIVER,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: 2,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return user;
};

/** A rider with a pending request to `driverId`, not yet in any group. */
const seedRiderWithRequest = async (n: number, driverId: string) => {
  const user = await prisma.user.create({
    data: { name: `Rider ${n}`, email: `rider-${n}@northeastern.edu` },
  });
  const home = await seedLocation(`${n} Mass Ave`);
  const company = await seedLocation(`${n} Boylston St`);
  await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role: Role.RIDER,
      status: Status.ACTIVE,
      companyName: "Riverside Labs",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: 0,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  await prisma.request.create({
    data: {
      message: `Carpool, rider ${n}?`,
      fromUserId: user.id,
      toUserId: driverId,
      status: RequestStatus.PENDING,
    },
  });
  return user;
};

describe("the driver's own link closes the race between two concurrent accepts", () => {
  it("lets exactly one of two concurrent accepts against the same driver link the driver", async () => {
    const driver = await seedDriver();
    const [riderA, riderB] = await Promise.all([
      seedRiderWithRequest(0, driver.id),
      seedRiderWithRequest(1, driver.id),
    ]);

    const results = await Promise.allSettled(
      [riderA, riderB].map((rider) =>
        callerFor(driver.id).user.groups.create({
          driverId: driver.id,
          riderId: rider.id,
        }),
      ),
    );

    const fulfilled = results.filter(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<{ id: string }>[];
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly one accept may link the driver. Both succeeding is the bug
    // this closes - it is what would leave a driverless group behind with
    // the loser's rider genuinely accepted into it.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: "CONFLICT" });

    const winningGroupId = fulfilled[0].value.id;

    const driverSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: driver.id },
    });
    expect(driverSearch?.carpoolId).toBe(winningGroupId);
    // Only the winner's reservation survives - the loser's transaction rolled
    // back its own seat decrement along with everything else it had written.
    expect(driverSearch?.seatsAvail).toBe(1);

    // No orphaned group: the loser's `CarpoolGroup` row and rider link were
    // rolled back with it, so exactly one group exists, and it has a driver.
    expect(await prisma.carpoolGroup.count()).toBe(1);

    const riderASearch = await prisma.carpoolSearch.findFirst({
      where: { userId: riderA.id },
    });
    const riderBSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: riderB.id },
    });

    // Exactly one rider ended up in the winning group; the other stayed
    // unlinked, and their request stayed PENDING rather than being marked
    // ACCEPTED for a group that no longer exists.
    const linkedRiderSearches = [riderASearch, riderBSearch].filter(
      (search) => search?.carpoolId === winningGroupId,
    );
    expect(linkedRiderSearches).toHaveLength(1);

    const unlinkedRider =
      riderASearch?.carpoolId === winningGroupId ? riderB : riderA;
    const unlinkedRequest = await prisma.request.findFirst({
      where: { fromUserId: unlinkedRider.id, toUserId: driver.id },
    });
    expect(unlinkedRequest?.status).toBe(RequestStatus.PENDING);
  });
});
