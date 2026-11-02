import { Role, Status } from "@prisma/client";
import { integrationPrisma } from "../../testing/integrationDatabase";
import { LIVE_COOP_END, LIVE_COOP_START } from "../../testing/liveCoopWindow";
import { RIDER_DEMAND_FLOOR } from "../../utils/riderDemand/floor";
import { riderDemandCount } from "./riderDemand";

/**
 * What the rider-demand count actually counts, against a real MySQL.
 *
 * The mocked suite beside this file proves the *rules* — the floor, the
 * hypothetical, who is asked. It cannot prove the count is right, because the
 * three exclusions SCRUM-638 names are all SQL: the two-directional `OR` in
 * `blocks.ts`, `carpoolId: null` on the candidate, and the `OR` over end
 * dates in `coopIsLiveFilter`. A fake `prisma` returns whatever it was told
 * to; only a database applies them.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 *
 * ## Reading the numbers
 *
 * Every assertion is written against `RIDER_DEMAND_FLOOR` rather than against
 * a literal 3. The floor is a product decision that may move, and a suite
 * that hard-coded it would fail on a change that was correct — or, worse,
 * keep passing while silently testing a different rule. Each test seeds
 * `FLOOR + 1` riders so that removing exactly one is still a *visible* number
 * rather than a drop into suppression: `null` would be the same answer this
 * query gives for "nobody at all", so it could not tell an exclusion that
 * worked from one that emptied the result for an unrelated reason.
 */

const prisma = integrationPrisma();

/**
 * `FLOOR + 2`, so that removing *two* riders still lands on a number the
 * reader would be shown.
 *
 * `FLOOR + 1` is the obvious choice and is wrong for the block test, which
 * excludes one rider in each direction: the second removal drops the count
 * under the floor, `riderDemandCount` suppresses it, and the assertion sees
 * `null` — the same answer it would get if the query had broken entirely. The
 * floor makes "one fewer" and "nothing at all" indistinguishable, so a fixture
 * that counts down has to stay above it the whole way.
 */
const SEEDED_RIDERS = RIDER_DEMAND_FLOOR + 2;

/**
 * An onboarded, ACTIVE user with a live search and two Locations in the same
 * corridor.
 *
 * All fixtures share one pair of coordinates, so every candidate is zero miles
 * from the reader and comfortably inside `RIDER_DEMAND_RADIUS_MILES`. This
 * suite is about the exclusions, not the geography — a fixture placed near the
 * radius boundary would make a failure here ambiguous between the two.
 */
const seedSearcher = async (
  name: string,
  role: Role,
  overrides: {
    carpoolId?: string;
    seatsAvail?: number;
    startDate?: Date | null;
    endDate?: Date | null;
    status?: Status;
  } = {},
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
      status: overrides.status ?? Status.ACTIVE,
      companyName: "Acme Robotics",
      daysWorking: "0,1,1,1,1,1,0",
      seatsAvail: overrides.seatsAvail ?? (role === Role.DRIVER ? 3 : 0),
      startDate:
        overrides.startDate === undefined
          ? LIVE_COOP_START
          : overrides.startDate,
      endDate:
        overrides.endDate === undefined ? LIVE_COOP_END : overrides.endDate,
      carpoolId: overrides.carpoolId,
      homeLocationId: home.id,
      companyLocationId: company.id,
    },
  });
  return user;
};

/** The count this reader would be shown. */
const demandFor = async (userId: string) => {
  const search = await prisma.carpoolSearch.findFirstOrThrow({
    where: { userId },
    include: {
      user: { select: { id: true } },
      homeLocation: true,
      companyLocation: true,
    },
  });

  return riderDemandCount({ prisma, userId, search });
};

/** `n` ungrouped, live riders in the reader's corridor. */
const seedRiders = async (n: number) => {
  const riders = [];
  for (let i = 0; i < n; i++) {
    riders.push(await seedSearcher(`Rider${i}`, Role.RIDER));
  }
  return riders;
};

describe("the rider-demand count against real rows", () => {
  it("counts the live, ungrouped riders a reader could carry", async () => {
    const reader = await seedSearcher("Reader", Role.RIDER);
    await seedRiders(SEEDED_RIDERS);

    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);
  });

  it("excludes a rider blocked in either direction", async () => {
    const reader = await seedSearcher("Reader", Role.RIDER);
    const riders = await seedRiders(SEEDED_RIDERS);

    // Positive control. Without it, a count that came back one short for some
    // unrelated reason would read as a working block.
    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);

    // The reader blocked them.
    await prisma.block.create({
      data: { blockerId: reader.id, blockedId: riders[0].id },
    });
    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS - 1);

    // They blocked the reader. The other direction of the same `OR`, and the
    // half a one-sided query would miss - a reader would be invited to drive
    // for someone who had blocked them.
    await prisma.block.create({
      data: { blockerId: riders[1].id, blockedId: reader.id },
    });
    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS - 2);
  });

  it("excludes a rider who is already in a carpool group", async () => {
    const reader = await seedSearcher("Reader", Role.RIDER);
    const riders = await seedRiders(SEEDED_RIDERS);

    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);

    const group = await prisma.carpoolGroup.create({ data: {} });
    await prisma.carpoolSearch.update({
      where: { userId: riders[0].id },
      data: { carpoolId: group.id },
    });

    // Not a preference: `groups.ts` requires a rider's own `carpoolId` to be
    // null before either accept path will link them, so a grouped rider is
    // demand this reader could not serve however willing they were.
    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS - 1);
  });

  it("excludes a rider whose co-op has already ended", async () => {
    const reader = await seedSearcher("Reader", Role.RIDER);
    await seedRiders(SEEDED_RIDERS);

    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);

    // The rule SCRUM-631 built and the reason this ticket was sequenced
    // behind it. On production this was 1,131 rows - counted without it, the
    // notice would quote demand that stopped existing months ago.
    await seedSearcher("Ended", Role.RIDER, {
      startDate: new Date(Date.UTC(2022, 0, 1)),
      endDate: new Date(Date.UTC(2023, 0, 1)),
    });

    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);
  });

  it("counts neither drivers, viewers, paused searches nor un-onboarded signups", async () => {
    const reader = await seedSearcher("Reader", Role.RIDER);
    await seedRiders(SEEDED_RIDERS);

    await seedSearcher("OtherDriver", Role.DRIVER);
    await seedSearcher("Viewer", Role.VIEWER);
    await seedSearcher("Paused", Role.RIDER, { status: Status.INACTIVE });

    const unonboarded = await seedSearcher("Unonboarded", Role.RIDER);
    await prisma.user.update({
      where: { id: unonboarded.id },
      data: { isOnboarded: false },
    });

    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);
  });

  it("suppresses the count below the floor rather than returning it", async () => {
    const reader = await seedSearcher("Reader", Role.RIDER);
    await seedRiders(RIDER_DEMAND_FLOOR - 1);

    // The rows exist and the query found them; the floor is what the reader
    // is not told. This is the assertion that would fail if the floor were
    // applied in the component instead - the number would be on the wire.
    expect(await demandFor(reader.id)).toBeNull();
  });

  it("tells a reader already in a group nothing, since their role is locked", async () => {
    const group = await prisma.carpoolGroup.create({ data: {} });
    const reader = await seedSearcher("Reader", Role.RIDER, {
      carpoolId: group.id,
    });
    await seedRiders(SEEDED_RIDERS);

    expect(await demandFor(reader.id)).toBeNull();
  });

  it("tells a driver nothing, since they have already answered the question", async () => {
    const reader = await seedSearcher("Reader", Role.DRIVER);
    await seedRiders(SEEDED_RIDERS);

    expect(await demandFor(reader.id)).toBeNull();
  });

  it("answers a VIEWER, who is the role the feature is aimed at", async () => {
    const reader = await seedSearcher("Reader", Role.VIEWER);
    await seedRiders(SEEDED_RIDERS);

    // A VIEWER's own search is excluded from everyone else's candidates, but
    // that is about them being found - it says nothing about what they can be
    // told. The hypothetical makes them a DRIVER, so the query runs.
    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);
  });

  it("does not depend on the reader's own stored seat count", async () => {
    // The trap `HYPOTHETICAL_SEATS` exists for: a rider's row carries
    // `seatsAvail: 0`, and a hypothetical that inherited it would hit
    // `searcherCanMatchNobody` and return nothing for every reader on the
    // platform - a feature that silently never fires.
    const reader = await seedSearcher("Reader", Role.RIDER, { seatsAvail: 0 });
    await seedRiders(SEEDED_RIDERS);

    expect(await demandFor(reader.id)).toBe(SEEDED_RIDERS);
  });
});
