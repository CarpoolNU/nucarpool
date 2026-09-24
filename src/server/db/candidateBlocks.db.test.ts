import { Role, Status } from "@prisma/client";
import { integrationPrisma } from "../../testing/integrationDatabase";
import { anyFilters } from "../../utils/recommendation.fixtures";
import { candidateExclusions, fetchRankedCandidates } from "./candidateSearch";

/**
 * A block keeps a pair out of each other's candidates, against a real MySQL
 * (SCRUM-554).
 *
 * The mocked suites prove the exclusion list is *built*. Only a real database
 * proves it is *applied*: that the `OR` over both directions in `blocks.ts` is
 * valid SQL for this schema, and that `userId.notIn` really drops the rows.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

/** An onboarded, ACTIVE user with a search and two nearby Locations. */
const seedSearcher = async (name: string, role: Role) => {
  const user = await prisma.user.create({
    data: {
      name,
      email: `${name.toLowerCase()}@northeastern.edu`,
      isOnboarded: true,
    },
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
      role,
      status: Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: role === Role.DRIVER ? 3 : 0,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return user;
};

/** The ids `fetchRankedCandidates` returns to `userId`, sorted. */
const candidateIdsFor = async (userId: string) => {
  const currentUserSearch = await prisma.carpoolSearch.findFirstOrThrow({
    where: { userId },
    include: {
      user: { select: { id: true } },
      homeLocation: true,
      companyLocation: true,
    },
  });

  const excludedUserIds = await candidateExclusions({
    prisma,
    userId,
    // "Show people I've messaged", so blocks are the only exclusion in play.
    messaged: true,
    sentRequests: undefined,
    receivedRequests: undefined,
  });

  const ranked = await fetchRankedCandidates({
    prisma,
    currentUserSearch,
    filters: { ...anyFilters(), favorites: false },
    sort: "any",
    excludedUserIds,
    favoriteUserIds: [],
  });

  return ranked.map((search) => search.userId).sort();
};

describe("a block in the candidate query", () => {
  it("excludes the pair in both directions and leaves a control user alone", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER);
    const blockedByRider = await seedSearcher("Blocked", Role.DRIVER);
    const blockerOfRider = await seedSearcher("Blocker", Role.DRIVER);
    const control = await seedSearcher("Control", Role.DRIVER);

    // Positive control first: with no blocks, every driver is a candidate. An
    // empty result below would otherwise be indistinguishable from a working
    // exclusion.
    expect(await candidateIdsFor(rider.id)).toEqual(
      [blockedByRider.id, blockerOfRider.id, control.id].sort(),
    );

    await prisma.block.create({
      data: { blockerId: rider.id, blockedId: blockedByRider.id },
    });
    await prisma.block.create({
      data: { blockerId: blockerOfRider.id, blockedId: rider.id },
    });

    // The rider sees neither side of either block.
    expect(await candidateIdsFor(rider.id)).toEqual([control.id]);

    // And neither blocked driver sees the rider, whoever placed the block.
    // The control driver still does.
    expect(await candidateIdsFor(blockedByRider.id)).toEqual([]);
    expect(await candidateIdsFor(blockerOfRider.id)).toEqual([]);
    expect(await candidateIdsFor(control.id)).toEqual([rider.id]);
  });

  it("restores the pair when the block is removed", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER);
    const driver = await seedSearcher("Driver", Role.DRIVER);

    await prisma.block.create({
      data: { blockerId: rider.id, blockedId: driver.id },
    });
    expect(await candidateIdsFor(rider.id)).toEqual([]);

    await prisma.block.deleteMany({
      where: { blockerId: rider.id, blockedId: driver.id },
    });
    expect(await candidateIdsFor(rider.id)).toEqual([driver.id]);
  });
});
