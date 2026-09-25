import { Prisma, Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * SCRUM-566: a block landing at the same instant as a group-join accept must
 * never leave the blocked pair sharing a `carpoolId`.
 *
 * `applyBlock` refuses a block between two people who already share a group,
 * and `groups.create`/`groups.edit` refuse to link a pair with a block
 * between them - but each used to check the *other* side's state with a
 * plain, non-locking read inside its own interactive transaction. Under MySQL
 * REPEATABLE READ that read answers from the transaction's starting
 * snapshot, not the current row, so a block placed at the same moment a
 * request is being accepted could have each side pass its own check against
 * the other's pre-race state and both commit. The mocked suite
 * (`groups.test.ts`, `blocks.test.ts`) cannot reproduce this at all - a
 * mocked Prisma has no isolation level - so this needs a real MySQL.
 *
 * Same barrier technique as `groupRoleRace.db.test.ts`: force each
 * transaction to take its REPEATABLE READ snapshot (the first consistent
 * read) and then wait for the other side to have taken its own, before
 * either transaction's actual business logic runs. That reproduces the exact
 * window the ticket describes instead of leaving it to timing.
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

const seedSearch = async (opts: {
  name: string;
  email: string;
  role: Role;
  seatsAvail: number;
  city: string;
}) => {
  const user = await prisma.user.create({
    data: { name: opts.name, email: opts.email },
  });
  const home = await prisma.location.create({
    data: {
      city: opts.city,
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
      role: opts.role,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: opts.seatsAvail,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return user;
};

/**
 * Wraps `$transaction` so that every call takes its REPEATABLE READ snapshot
 * (a plain, non-locking read) and then waits for a sibling call to do the
 * same before running its actual logic. One instance is shared by both
 * callers below, so `arrived` counts across the two procedures rather than
 * within a single one's retries. Identical to `groupRoleRace.db.test.ts`'s
 * helper of the same name.
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

/**
 * Seeds a driver with one open seat and a rider, both ungrouped, with a
 * pending request from the rider to the driver - so the driver may accept.
 */
const seedPair = async () => {
  const driver = await seedSearch({
    name: "Driver Dan",
    email: "driver-dan-566@northeastern.edu",
    role: Role.DRIVER,
    seatsAvail: 1,
    city: "Somerville",
  });
  const rider = await seedSearch({
    name: "Rider Rae",
    email: "rider-rae-566@northeastern.edu",
    role: Role.RIDER,
    seatsAvail: 0,
    city: "Cambridge",
  });
  await prisma.request.create({
    data: {
      message: "Want to carpool?",
      fromUserId: rider.id,
      toUserId: driver.id,
      status: RequestStatus.PENDING,
    },
  });
  return { driver, rider };
};

const blockExistsBetween = async (userA: string, userB: string) =>
  (await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA },
      ],
    },
  })) !== null;

describe("a block racing a group-join accept (SCRUM-566)", () => {
  it.each([
    // Both directions: the blocker is the driver, and the blocker is the
    // rider. `applyBlock`'s new locking read touches both users' rows
    // regardless of direction, but the *order* MySQL locks them in can
    // depend on which id is `blockerId` versus `blockedId`, so both are
    // exercised rather than assuming symmetry.
    ["the driver blocks the rider", (d: string, r: string) => [d, r] as const],
    ["the rider blocks the driver", (d: string, r: string) => [r, d] as const],
  ])(
    "never leaves the pair sharing a carpoolId when %s",
    async (_label, pick) => {
      const { driver, rider } = await seedPair();
      const [blockerId, blockedId] = pick(driver.id, rider.id);

      const racing = buildRacingClient(prisma, 2);

      const results = await Promise.allSettled([
        callerFor(driver.id, racing).user.groups.create({
          driverId: driver.id,
          riderId: rider.id,
        }),
        callerFor(blockerId, racing).user.blocks.block({ userId: blockedId }),
      ]);
      const [createResult, blockResult] = results;

      const riderSearch = await prisma.carpoolSearch.findFirst({
        where: { userId: rider.id },
      });
      const blocked = await blockExistsBetween(driver.id, rider.id);

      // The one invariant that must hold regardless of which side won: never
      // both a block and a shared group.
      expect(blocked && riderSearch?.carpoolId !== null).toBe(false);

      if (createResult.status === "fulfilled") {
        // The accept won: the pair share the new group, and the block that
        // raced it must have been refused because they now share it.
        const group = createResult.value as { id: string };
        expect(riderSearch).toMatchObject({ carpoolId: group.id });
        expect(blocked).toBe(false);
        expect(blockResult.status).toBe("rejected");
        expect((blockResult as PromiseRejectedResult).reason).toMatchObject({
          code: "CONFLICT",
        });
      } else {
        // The block won: the pair are not grouped, and the accept that raced
        // it must have been refused by the post-claim recheck - rolling back
        // the seat and the group along with the membership.
        expect(riderSearch?.carpoolId).toBeNull();
        expect(blocked).toBe(true);
        expect(blockResult.status).toBe("fulfilled");
        expect((createResult as PromiseRejectedResult).reason).toMatchObject({
          code: "FORBIDDEN",
        });
        expect(await prisma.carpoolGroup.count()).toBe(0);

        const driverSearch = await prisma.carpoolSearch.findFirst({
          where: { userId: driver.id },
        });
        expect(driverSearch?.seatsAvail).toBe(1);
      }
    },
  );
});
