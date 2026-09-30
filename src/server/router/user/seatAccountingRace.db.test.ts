import { Prisma, Role, Status, RequestStatus } from "@prisma/client";
import type { Session } from "next-auth";
import { MAX_SEATS_AVAILABLE } from "../../../utils/carpoolSeats";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * A driver's `seats_avail` must not drift from the number of riders their
 * group actually holds, and an accept whose request is gone must leave
 * nothing behind.
 *
 * `reserveSeat` became a raw compare-and-swap in SCRUM-565, but the writes
 * around it went on trusting a value or a row read earlier in the same
 * transaction:
 *
 *   - `releaseSeats` wrote `clampSeats(currentSeats + n)` from a read its
 *     caller had already taken, so a `reserveSeat` that committed in between
 *     was overwritten;
 *   - the remove path's unlink matched on `userId` alone, so a second removal
 *     of the same member still "changed a row" and still credited a seat;
 *   - `user.edit` decided whether to write `seatsAvail` at all from a
 *     `carpoolId` a concurrent accept can have invalidated;
 *   - `markRequestAccepted` discarded its match count, so a request withdrawn
 *     after `requireAcceptableRequest` read it - that check runs *outside*
 *     the transaction - still produced a group and a spent seat.
 *
 * None of that is reproducible under the mocked suite. `groups.test.ts` can
 * drive each guard directly, and does, but a mocked Prisma has no isolation
 * level, so it cannot produce the stale read that is the whole defect. Only a
 * real MySQL at REPEATABLE READ can - which is how the `updateMany` finding
 * behind SCRUM-565 was established in the first place.
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

/**
 * A client whose next interactive transaction takes its REPEATABLE READ
 * snapshot, lets `interleaved` run to completion, and only then runs the
 * procedure's own logic.
 *
 * `groupRoleRace.db.test.ts` uses a two-sided barrier, which reproduces
 * "both transactions pass their checks before either commits". These defects
 * need the stronger and more specific thing: one transaction's snapshot
 * predates a commit it must nevertheless not act on. Forcing that ordering
 * rather than racing for it is what makes these tests deterministic - a
 * coin-flip race passes half the time by taking the branch that was never
 * broken, and says nothing on the other runs.
 *
 * The snapshot is taken with a plain, non-locking read, so `interleaved`
 * cannot deadlock against it: nothing is locked yet.
 *
 * Once only. `user.edit` retries its whole transaction when two first-time
 * saves collide, and re-running the interleaved work on the retry would
 * change what is being tested.
 */
const buildDelayedClient = (
  client: typeof prisma,
  interleaved: () => Promise<unknown>,
) => {
  let alreadyRun = false;

  return new Proxy(client, {
    get(target, property) {
      if (property !== "$transaction") {
        return Reflect.get(target, property);
      }
      return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM carpool_search LIMIT 1`;
          if (!alreadyRun) {
            alreadyRun = true;
            await interleaved();
          }
          return fn(tx);
        });
    },
  }) as typeof client;
};

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
  return { user, search: carpoolSearch, home, company };
};

/** A driver already in a group of their own, which the test then fills. */
const seedGroupedDriver = async (
  name: string,
  email: string,
  seatsAvail: number,
) => {
  const driver = await seedUser(name, email, { role: Role.DRIVER, seatsAvail });
  const group = await prisma.carpoolGroup.create({ data: {} });
  await prisma.carpoolSearch.update({
    where: { id: driver.search.id },
    data: { carpoolId: group.id },
  });
  return { ...driver, group };
};

const seedPendingRequest = (fromUserId: string, toUserId: string) =>
  prisma.request.create({
    data: {
      message: "Want to carpool?",
      fromUserId,
      toUserId,
      status: RequestStatus.PENDING,
    },
  });

const seatsOf = async (userId: string) =>
  (await prisma.carpoolSearch.findFirst({ where: { userId } }))?.seatsAvail;

/** Riders currently linked into `groupId`, excluding its driver. */
const riderCountOf = (groupId: string) =>
  prisma.carpoolSearch.count({
    where: { carpoolId: groupId, role: Role.RIDER },
  });

describe("seat accounting under concurrent writers", () => {
  /**
   * Scenario B on the ticket. A rider leaves while another is accepted into
   * the same car. The leave snapshots `seats_avail = 1` and, on the old code,
   * writes `clamp(1 + 1) = 2` straight over the accept's decrement: the car
   * advertises two free seats while holding the same riders it started with,
   * and is overbooked by one on the next accept.
   */
  it("a leave does not overwrite an accept that committed after its snapshot", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dan",
      "driver-dan@northeastern.edu",
      1,
    );
    const leaving = await seedUser("Rider Rae", "rider-rae@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });
    // A bystander, so the group still has two members after the leave and is
    // not dissolved on the way out. Dissolution is a different code path.
    await seedUser("Rider Rho", "rider-rho@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });
    const joining = await seedUser("Rider Rio", "rider-rio@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    await seedPendingRequest(joining.user.id, driver.user.id);

    const accept = () =>
      callerFor(driver.user.id).user.groups.edit({
        driverId: driver.user.id,
        riderId: joining.user.id,
        groupId: driver.group.id,
        add: true,
      });

    await callerFor(
      leaving.user.id,
      buildDelayedClient(prisma, accept),
    ).user.groups.edit({
      driverId: driver.user.id,
      riderId: leaving.user.id,
      groupId: driver.group.id,
      add: false,
    });

    // One rider in, one rider out: the bystander and the joiner occupy two
    // seats of a three-seat car, so both counts are where they started.
    expect(await riderCountOf(driver.group.id)).toBe(2);
    expect(await seatsOf(driver.user.id)).toBe(1);
  });

  /**
   * The duplicate-leave case: an ordinary double submit, or a driver evicting
   * while the rider presses Leave. Both pass the `targetMembership` check,
   * because it is taken before the transaction. The unlink used to match on
   * `userId` alone and so "changed a row" for both, and the credit ran twice
   * for one departure.
   */
  it("a duplicate leave credits the seat exactly once", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dee",
      "driver-dee@northeastern.edu",
      1,
    );
    const leaving = await seedUser("Rider Ada", "rider-ada@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });
    // Three members, so the group survives the removal and the seat credit is
    // the only thing under test.
    await seedUser("Rider Bo", "rider-bo@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });

    const leave = {
      driverId: driver.user.id,
      riderId: leaving.user.id,
      groupId: driver.group.id,
      add: false,
    };

    // The rider's own Leave has already taken its snapshot - so its
    // pre-transaction membership check has passed - when the driver's evict
    // runs to completion underneath it.
    const evict = () => callerFor(driver.user.id).user.groups.edit(leave);

    await expect(
      callerFor(
        leaving.user.id,
        buildDelayedClient(prisma, evict),
      ).user.groups.edit(leave),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // One departure, one seat.
    //
    // Worth being exact about what this pins. The old absolute write happens
    // to land on the right number here - `clamp(staleSeats + 1)` with a
    // snapshot taken before the evict is 2, which is also the truth - so this
    // ordering did not expose the duplicate credit while the release was an
    // absolute write. It does now: an increment against the current value
    // would give 3 without the count check, so making the release atomic is
    // what makes the check load-bearing. The two changes have to ship
    // together, which is why they are one ticket.
    expect(await riderCountOf(driver.group.id)).toBe(1);
    expect(await seatsOf(driver.user.id)).toBe(2);
  });

  /**
   * Scenario C on the ticket. A driver saves any profile field - the bio, say
   * - while a rider is being accepted. `user.edit`'s snapshot shows
   * `carpoolId = null` even after the acceptance has committed, so its
   * `seatsAvail` write went ahead and erased the decrement.
   */
  it("a profile save does not erase an accept that committed after its snapshot", async () => {
    const driver = await seedUser("Driver Del", "driver-del@northeastern.edu", {
      role: Role.DRIVER,
      seatsAvail: 2,
    });
    const rider = await seedUser("Rider Ren", "rider-ren@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    await seedPendingRequest(rider.user.id, driver.user.id);

    const accept = () =>
      callerFor(driver.user.id).user.groups.create({
        driverId: driver.user.id,
        riderId: rider.user.id,
      });

    // The save changes only the bio. `seatAvail` is whatever the form loaded,
    // which is the pre-acceptance count - exactly what a real client sends,
    // and indistinguishable from an intended change, which is why the guard
    // skips the write rather than refusing the save.
    await callerFor(
      driver.user.id,
      buildDelayedClient(prisma, accept),
    ).user.edit({
      role: Role.DRIVER,
      status: Status.ACTIVE,
      seatAvail: 2,
      companyName: "Acme Robotics",
      companyAddress: `${driver.user.email} work`,
      companyCoordLng: -71.05,
      companyCoordLat: 42.36,
      startAddress: `${driver.user.email} home`,
      startCoordLng: -71.05,
      startCoordLat: 42.36,
      preferredName: "Del",
      pronouns: "",
      isOnboarded: true,
      daysWorking: "0,1,1,1,1,1,0",
      coopStartDate: null,
      coopEndDate: null,
      bio: "Now with a bio.",
      startStreet: `${driver.user.email} home`,
      startCity: "Boston",
      startState: "MA",
      companyStreet: `${driver.user.email} work`,
      companyCity: "Boston",
      companyState: "MA",
    });

    const driverSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: driver.user.id },
    });

    // One rider joined a two-seat car. The defect leaves this at 2.
    expect(driverSearch?.seatsAvail).toBe(1);
    expect(driverSearch?.carpoolId).not.toBeNull();

    // And the change the user actually made is not lost to the seat guard -
    // the write is skipped, not the save.
    const savedUser = await prisma.user.findUnique({
      where: { id: driver.user.id },
    });
    expect(savedUser?.bio).toBe("Now with a bio.");
  });

  /**
   * Scenario D on the ticket. `requireAcceptableRequest` reads the request as
   * PENDING *outside* the transaction, so a withdrawal that commits before
   * the accept does still satisfies every check the accept made.
   * `markRequestAccepted` matched nothing and said nothing, and a group
   * existed with no request behind it, its driver a seat short.
   */
  it("a request withdrawn during the accept leaves no group and no spent seat", async () => {
    const driver = await seedUser("Driver Dax", "driver-dax@northeastern.edu", {
      role: Role.DRIVER,
      seatsAvail: 2,
    });
    const rider = await seedUser("Rider Rue", "rider-rue@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const request = await seedPendingRequest(rider.user.id, driver.user.id);

    const withdraw = () =>
      callerFor(rider.user.id).user.requests.delete({
        invitationId: request.id,
      });

    await expect(
      callerFor(
        driver.user.id,
        buildDelayedClient(prisma, withdraw),
      ).user.groups.create({
        driverId: driver.user.id,
        riderId: rider.user.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // Everything the accept had already written has to have gone back.
    expect(await prisma.carpoolGroup.count()).toBe(0);
    expect(await seatsOf(driver.user.id)).toBe(2);
    expect(await prisma.request.count()).toBe(0);

    const driverSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: driver.user.id },
    });
    const riderSearch = await prisma.carpoolSearch.findFirst({
      where: { userId: rider.user.id },
    });
    expect(driverSearch?.carpoolId).toBeNull();
    expect(riderSearch?.carpoolId).toBeNull();
  });

  /**
   * The positive control for the test above. The resolution is a
   * compare-and-swap on PENDING now, so an accept that can never match would
   * make that test pass for the wrong reason.
   */
  it("an undisturbed accept still resolves the request and takes the seat", async () => {
    const driver = await seedUser("Driver Dia", "driver-dia@northeastern.edu", {
      role: Role.DRIVER,
      seatsAvail: 2,
    });
    const rider = await seedUser("Rider Raf", "rider-raf@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
    });
    const request = await seedPendingRequest(rider.user.id, driver.user.id);

    await callerFor(driver.user.id).user.groups.create({
      driverId: driver.user.id,
      riderId: rider.user.id,
    });

    expect(await prisma.carpoolGroup.count()).toBe(1);
    expect(await seatsOf(driver.user.id)).toBe(1);

    const resolved = await prisma.request.findUnique({
      where: { id: request.id },
    });
    expect(resolved?.status).toBe(RequestStatus.ACCEPTED);
    expect(resolved?.acceptanceNotificationPendingSince).not.toBeNull();
  });

  /**
   * `releaseSeats` is SQL rather than JavaScript now, so what it computes is
   * MySQL's answer and not `clampSeats`'s. Nothing else in the suite checks
   * that: `groups.test.ts` reimplements the arithmetic in its mock, so it
   * agrees with itself by construction.
   */
  it("dissolving a group credits one seat per rider detached", async () => {
    const driver = await seedGroupedDriver(
      "Driver Dot",
      "driver-dot@northeastern.edu",
      1,
    );
    await seedUser("Rider Rin", "rider-rin@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });
    await seedUser("Rider Ros", "rider-ros@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });

    await callerFor(driver.user.id).user.groups.delete({
      groupId: driver.group.id,
    });

    expect(await prisma.carpoolGroup.count()).toBe(0);
    expect(await seatsOf(driver.user.id)).toBe(3);
  });

  it("a release cannot push the count past the maximum", async () => {
    // `GREATEST(0, LEAST(seats_avail + n, MAX))` is `clampSeats` in SQL, and
    // the upper bound is the one the old clamp enforced on this path.
    const driver = await seedGroupedDriver(
      "Driver Dev",
      "driver-dev@northeastern.edu",
      MAX_SEATS_AVAILABLE,
    );
    await seedUser("Rider Raj", "rider-raj@northeastern.edu", {
      role: Role.RIDER,
      seatsAvail: 0,
      carpoolId: driver.group.id,
    });

    await callerFor(driver.user.id).user.groups.delete({
      groupId: driver.group.id,
    });

    expect(await seatsOf(driver.user.id)).toBe(MAX_SEATS_AVAILABLE);
  });
});
