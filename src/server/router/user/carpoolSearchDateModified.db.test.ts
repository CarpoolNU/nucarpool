import { Permission, RequestStatus, Role, Status } from "@prisma/client";
import type { Session } from "next-auth";
import { integrationPrisma } from "../../../testing/integrationDatabase";
import type { Context } from "../context";
import { appRouter } from "../index";

/**
 * Every raw `UPDATE carpool_search` advances `date_modified` (SCRUM-727).
 *
 * The column has no `ON UPDATE CURRENT_TIMESTAMP`, so only Prisma's
 * `@updatedAt` moves it - and raw SQL bypasses that. A statement that forgets
 * to assign it leaves a changed row looking untouched, which nothing in the
 * application notices and anything reading the column as "last changed" (data
 * audits, `scripts/repair-dst-schedule-times.ts`) gets wrong. Only MySQL can
 * show the effect, so this needs a real database.
 *
 * Each row is backdated to a sentinel first and must have moved past it after
 * the procedure. The paths below were chosen because nothing else on them
 * writes `carpool_search` through Prisma, so `@updatedAt` cannot pass the
 * assertion on a statement's behalf:
 *
 *   - `groups.create` - the rider's link. The driver row is touched by both
 *     `reserveSeat` and the driver link, so it cannot tell them apart.
 *   - `groups.edit` with `add` - `reserveSeat` alone on the driver, the edit
 *     path's rider link alone on the rider.
 *   - `admin.setUserToViewer` - the demotion.
 *
 * The driver link on its own, and `user.edit`'s role claim (which is always
 * followed by a `carpoolSearch.update`), have no path that isolates them.
 * `carpoolSearchRawUpdates.test.ts` covers every statement's text instead.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`.
 */

const prisma = integrationPrisma();

const SENTINEL = new Date("2020-01-01T00:00:00.000Z");

const sessionFor = (
  id: string,
  permission: Permission = Permission.USER,
): Session =>
  ({
    expires: new Date(Date.now() + 60_000).toISOString(),
    user: { id, isOnboarded: true, tutorialCompleted: true, permission },
  }) as unknown as Session;

const callerFor = (session: Session) =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
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

const seedSearcher = async (
  n: number,
  role: Role,
  seatsAvail: number,
): Promise<string> => {
  const user = await prisma.user.create({
    data: { name: `Person ${n}`, email: `person-${n}@northeastern.edu` },
  });
  const home = await seedLocation(`${n} Mass Ave`);
  const company = await seedLocation(`${n} Boylston St`);
  await prisma.carpoolSearch.create({
    data: {
      userId: user.id,
      role,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return user.id;
};

const seedRequest = (fromUserId: string, toUserId: string) =>
  prisma.request.create({
    data: {
      message: "Carpool?",
      fromUserId,
      toUserId,
      status: RequestStatus.PENDING,
    },
  });

/** Raw on purpose: an explicit Prisma write would be re-stamped by `@updatedAt`. */
const backdate = (userIds: string[]) =>
  Promise.all(
    userIds.map(
      (userId) => prisma.$executeRaw`
        UPDATE carpool_search
        SET date_modified = ${SENTINEL}
        WHERE userId = ${userId}
      `,
    ),
  );

const dateModifiedOf = async (userId: string) =>
  (
    await prisma.carpoolSearch.findUniqueOrThrow({
      where: { userId },
      select: { dateModified: true },
    })
  ).dateModified.getTime();

describe("raw carpool_search writes advance date_modified", () => {
  it("groups.create stamps the rider it links", async () => {
    const driver = await seedSearcher(1, Role.DRIVER, 2);
    const rider = await seedSearcher(2, Role.RIDER, 0);
    await seedRequest(rider, driver);
    await backdate([driver, rider]);

    await callerFor(sessionFor(driver)).user.groups.create({
      driverId: driver,
      riderId: rider,
    });

    expect(await dateModifiedOf(rider)).toBeGreaterThan(SENTINEL.getTime());
    expect(await dateModifiedOf(driver)).toBeGreaterThan(SENTINEL.getTime());
  });

  it("groups.edit stamps the driver's seat reservation and the rider it links", async () => {
    const driver = await seedSearcher(1, Role.DRIVER, 2);
    const firstRider = await seedSearcher(2, Role.RIDER, 0);
    const secondRider = await seedSearcher(3, Role.RIDER, 0);
    await seedRequest(firstRider, driver);
    await seedRequest(secondRider, driver);

    const caller = callerFor(sessionFor(driver));
    const group = await caller.user.groups.create({
      driverId: driver,
      riderId: firstRider,
    });
    await backdate([driver, firstRider, secondRider]);

    await caller.user.groups.edit({
      driverId: driver,
      riderId: secondRider,
      groupId: group.id,
      add: true,
    });

    expect(await dateModifiedOf(driver)).toBeGreaterThan(SENTINEL.getTime());
    expect(await dateModifiedOf(secondRider)).toBeGreaterThan(
      SENTINEL.getTime(),
    );
    // The control: a member the edit did not write keeps the sentinel, so the
    // two assertions above are about these statements and not about a stamp
    // landing on every row.
    expect(await dateModifiedOf(firstRider)).toBe(SENTINEL.getTime());
  });

  it("admin.setUserToViewer stamps the demoted search", async () => {
    const target = await seedSearcher(1, Role.RIDER, 0);
    await backdate([target]);

    await callerFor(
      sessionFor("manager-1", Permission.MANAGER),
    ).user.admin.setUserToViewer({ userId: target });

    const search = await prisma.carpoolSearch.findUniqueOrThrow({
      where: { userId: target },
      select: { role: true, dateModified: true },
    });
    expect(search.role).toBe(Role.VIEWER);
    expect(search.dateModified.getTime()).toBeGreaterThan(SENTINEL.getTime());
  });
});
