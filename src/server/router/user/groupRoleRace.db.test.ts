import { Prisma, Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * SCRUM-563: a profile save racing a request acceptance must never leave a
 * DRIVER inside the rider slot of a group.
 *
 * `user.edit` refuses a role change for a driver already in a group, and
 * `groups.create` / `groups.edit` refuse to link anyone but a RIDER into the
 * rider slot. Together those close the *ordinary* path to a two-driver group
 * (SCRUM-557). But each side reads the *other* side's column - `carpoolId`
 * and `role` respectively - with a plain read inside its own interactive
 * transaction, and under MySQL REPEATABLE READ that read is a snapshot: it
 * can go on reporting the pre-race value even after the other side has
 * committed. The mocked suite (`user.test.ts`, `groups.test.ts`) cannot
 * reproduce that at all - a mocked Prisma has no isolation level - so this
 * needs a real MySQL.
 *
 * The barrier technique is the one `user.db.test.ts`'s
 * "resolves two concurrent first-time saves to one search" test uses: force
 * each transaction to take its REPEATABLE READ snapshot (the first consistent
 * read) and then wait for the other side to have taken its own, before either
 * transaction's actual business logic runs. That reproduces the exact window
 * the ticket describes - both transactions pass their checks before either
 * commits - instead of leaving it to timing, where it "cannot be triggered
 * reliably" (the ticket's words) but is not actually prevented.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`.
 */

const prisma = integrationPrisma();

const sessionFor = (id: string): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true },
  }) as unknown as Session;

const callerFor = (userId: string, client: typeof prisma) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session: sessionFor(userId),
    prisma: client,
    sesClient: { send: jest.fn() },
  } as unknown as Context);

/** A driver with one open seat, not yet in any group. */
const seedDriver = async () => {
  const user = await prisma.user.create({
    data: { name: "Driver Dan", email: "driver-dan@northeastern.edu" },
  });
  const home = await prisma.location.create({
    data: {
      city: "Somerville",
      state: "MA",
      street: "Elm St",
      streetAddress: "12 Elm St",
      coordLng: -71.1,
      coordLat: 42.39,
    },
  });
  const company = await prisma.location.create({
    data: {
      city: "Boston",
      state: "MA",
      street: "Congress St",
      streetAddress: "1 Congress St",
      coordLng: -71.05,
      coordLat: 42.36,
    },
  });
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

/** A RIDER with no group yet, whose own profile save is the other half of the race. */
const seedRider = async () => {
  const user = await prisma.user.create({
    data: { name: "Rider Rae", email: "rider-rae@northeastern.edu" },
  });
  const home = await prisma.location.create({
    data: {
      city: "Cambridge",
      state: "MA",
      street: "Mass Ave",
      streetAddress: "77 Mass Ave",
      coordLng: -71.09,
      coordLat: 42.36,
    },
  });
  const company = await prisma.location.create({
    data: {
      city: "Boston",
      state: "MA",
      street: "Boylston St",
      streetAddress: "800 Boylston St",
      coordLng: -71.08,
      coordLat: 42.35,
    },
  });
  const search = await prisma.carpoolSearch.create({
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
  return { user, home, company, search };
};

/** The rider's `user.edit` input, changing only the role. */
const riderSavesAs = (role: Role) => ({
  role,
  status: Status.ACTIVE,
  seatAvail: role === Role.DRIVER ? 1 : 0,
  companyName: "Riverside Labs",
  companyAddress: "800 Boylston St",
  companyCoordLng: -71.08,
  companyCoordLat: 42.35,
  startAddress: "77 Mass Ave",
  startCoordLng: -71.09,
  startCoordLat: 42.36,
  preferredName: "Rae",
  pronouns: "",
  isOnboarded: true,
  daysWorking: "0,1,1,1,1,1,0",
  coopStartDate: null,
  coopEndDate: null,
  bio: "",
  startStreet: "Mass Ave",
  startCity: "Cambridge",
  startState: "MA",
  companyStreet: "Boylston St",
  companyCity: "Boston",
  companyState: "MA",
});

/**
 * Wraps `$transaction` so that every call takes its REPEATABLE READ snapshot
 * (a plain, non-locking read) and then waits for a sibling call to do the
 * same before running its actual logic. One instance is shared by both
 * callers below, so `arrived` counts across the two procedures rather than
 * within a single one's retries.
 */
const buildRacingClient = (client: typeof prisma, callers: number) => {
  let arrived = 0;
  let release: () => void = () => undefined;
  const everyoneArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return new Proxy(client, {
    get(target, property) {
      if (property !== "$transaction") {
        return Reflect.get(target, property);
      }
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM carpool_search LIMIT 1`;
          if (++arrived === callers) release();
          await everyoneArrived;
          return fn(tx);
        });
    },
  }) as typeof client;
};

describe("a role change racing a request acceptance (SCRUM-563)", () => {
  it("never leaves the rider as DRIVER inside the group", async () => {
    const driver = await seedDriver();
    const { user: rider, search: riderSearch } = await seedRider();

    await prisma.request.create({
      data: {
        message: "Want to carpool?",
        fromUserId: rider.id,
        toUserId: driver.id,
        status: RequestStatus.PENDING,
      },
    });

    const racing = buildRacingClient(prisma, 2);

    // The accept (driver calling `groups.create`) and the rider's own
    // profile save race each other: both take their snapshot, both wait for
    // the other, then both run their checks and writes concurrently.
    const results = await Promise.allSettled([
      callerFor(driver.id, racing).user.groups.create({
        driverId: driver.id,
        riderId: rider.id,
      }),
      callerFor(rider.id, racing).user.edit(riderSavesAs(Role.DRIVER)),
    ]);
    const [createResult, editResult] = results;

    // Exactly one side may land. Both succeeding is the bug this closes -
    // it is what would put a DRIVER in the rider slot - and both failing
    // would mean the compare-and-swap is refusing a legitimate winner too.
    expect(createResult.status === "fulfilled").not.toBe(
      editResult.status === "fulfilled",
    );

    const finalSearch = await prisma.carpoolSearch.findUnique({
      where: { id: riderSearch.id },
    });

    // The one invariant that must hold regardless of which side won.
    expect(
      finalSearch?.role === Role.DRIVER && finalSearch?.carpoolId !== null,
    ).toBe(false);

    if (createResult.status === "fulfilled") {
      // The accept won: the rider is RIDER, inside the group it just built,
      // and the profile save lost the compare-and-swap on `carpoolId`.
      const group = createResult.value as { id: string };
      expect(finalSearch).toMatchObject({
        role: Role.RIDER,
        carpoolId: group.id,
      });
      expect(editResult.status).toBe("rejected");
      expect((editResult as PromiseRejectedResult).reason).toMatchObject({
        code: "CONFLICT",
      });
    } else {
      // The profile save won: the rider is DRIVER, outside any group, and
      // the accept lost the compare-and-swap on `role` - which must have
      // rolled back the seat and the group along with the membership.
      expect(finalSearch).toMatchObject({ role: Role.DRIVER, carpoolId: null });
      expect(createResult.status).toBe("rejected");
      expect((createResult as PromiseRejectedResult).reason).toMatchObject({
        code: "CONFLICT",
      });
      expect(await prisma.carpoolGroup.count()).toBe(0);

      const driverSearch = await prisma.carpoolSearch.findFirst({
        where: { userId: driver.id },
      });
      expect(driverSearch?.seatsAvail).toBe(1);
    }
  });
});
