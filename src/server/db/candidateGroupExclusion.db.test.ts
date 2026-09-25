import { Role, Status } from "@prisma/client";
import { integrationPrisma } from "../../testing/integrationDatabase";
import { anyFilters } from "../../utils/recommendation.fixtures";
import { candidateExclusions, fetchRankedCandidates } from "./candidateSearch";

/**
 * SCRUM-560: every accept path requires the rider's own row to hold
 * `carpoolId: null` before it links them (`groups.ts`'s `create` and `add`),
 * so a rider already in a group can never join another - theirs or anyone
 * else's - and a grouped rider has no reachable driver at all. The mocked
 * suites in `candidateSearch.test.ts` and `recommendation.test.ts` prove the
 * `where` clause and the scorer agree on this; only a real database proves
 * the clause is valid SQL for this schema and is actually applied.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

/** An onboarded, ACTIVE user with a search and two nearby Locations. */
const seedSearcher = async (
  name: string,
  role: Role,
  overrides: { seatsAvail?: number; carpoolId?: string | null } = {},
) => {
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
      seatsAvail: overrides.seatsAvail ?? (role === Role.DRIVER ? 3 : 0),
      carpoolId: overrides.carpoolId ?? null,
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

describe("candidate exclusion across groups (SCRUM-560)", () => {
  it("keeps a driver's results down to ungrouped riders, whichever group each rider is in", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });

    const driver = await seedSearcher("Driver", Role.DRIVER, { seatsAvail: 3 });
    const ungroupedRider = await seedSearcher("Ungrouped", Role.RIDER);
    await seedSearcher("Grouped", Role.RIDER, { carpoolId: group.id });

    expect(await candidateIdsFor(driver.id)).toEqual([ungroupedRider.id]);
  });

  it("offers a grouped rider no candidates at all, since joining always requires their own carpoolId to be null", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });

    const groupedRider = await seedSearcher("Grouped", Role.RIDER, {
      carpoolId: group.id,
    });
    // A driver with a seat, unrelated to the rider's group. Under the old
    // exclusion (own group only) this would have been offered and ranked at
    // the top, for a request `groups.ts`'s accept path refuses every time.
    await seedSearcher("Driver", Role.DRIVER, { seatsAvail: 3 });

    expect(await candidateIdsFor(groupedRider.id)).toEqual([]);
  });

  it("still offers an ungrouped rider a grouped driver who has a seat left", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });

    const ungroupedRider = await seedSearcher("Ungrouped", Role.RIDER);
    const groupedDriver = await seedSearcher("Driver", Role.DRIVER, {
      seatsAvail: 2,
      carpoolId: group.id,
    });

    expect(await candidateIdsFor(ungroupedRider.id)).toEqual([
      groupedDriver.id,
    ]);
  });

  it("offers a full driver no rider candidates at all", async () => {
    const fullDriver = await seedSearcher("Driver", Role.DRIVER, {
      seatsAvail: 0,
    });
    await seedSearcher("Rider", Role.RIDER);

    expect(await candidateIdsFor(fullDriver.id)).toEqual([]);
  });
});
