import { Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * SCRUM-565: N riders accepted at once must never take more seats than a
 * driver actually has.
 *
 * `reserveSeat` guards the decrement with
 * `carpoolSearch.updateMany({ where: { seatsAvail: SEAT_AVAILABLE_FILTER } })`
 * and calls it a compare-and-swap. SCRUM-559 and SCRUM-563 each measured,
 * against a real MySQL, that this exact shape is not one on this Prisma
 * version: `updateMany`'s `WHERE` matched a concurrent transaction's own
 * REPEATABLE READ snapshot rather than the row's current committed state, so
 * every racing caller could see the pre-decrement value and all report
 * `count: 1`. The mocked suite (`groups.test.ts`) cannot reproduce that at
 * all - a mocked Prisma has no isolation level - so this needs a real MySQL.
 *
 * Unlike SCRUM-563's `groupRoleRace.db.test.ts`, no forced-interleaving
 * barrier is needed here: `groups.create` opens its own interactive
 * transaction per call, each of whose first statements (`driverSearch`,
 * `riderSearch`) takes that transaction's REPEATABLE READ snapshot. Kicking
 * off all N accepts with a single `Promise.all` starts every transaction, and
 * so every snapshot, before any of them has had time to commit - the several
 * round trips `create` makes between the seat check and the commit are ample
 * window - which is exactly what SCRUM-559's equivalent notification race
 * relied on too.
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

/** A driver with exactly one open seat, not yet in any group. */
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
      seatsAvail: 1,
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

describe("reserveSeat closes the race between concurrent accepts (SCRUM-565)", () => {
  it("lets exactly one of five concurrent accepts take a driver's last seat", async () => {
    const driver = await seedDriver();
    const riders = await Promise.all(
      Array.from({ length: 5 }, (_, i) => seedRiderWithRequest(i, driver.id)),
    );

    const results = await Promise.allSettled(
      riders.map((rider) =>
        callerFor(driver.id).user.groups.create({
          driverId: driver.id,
          riderId: rider.id,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    // Exactly one accept may take the seat. All five succeeding is the bug
    // this closes - it is what would leave `seatsAvail` at -4.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ code: "BAD_REQUEST" });
    }

    const driverSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: driver.id },
    });
    expect(driverSearch?.seatsAvail).toBe(0);

    // Only the winning accept may have built a group.
    expect(await prisma.carpoolGroup.count()).toBe(1);
  });
});
