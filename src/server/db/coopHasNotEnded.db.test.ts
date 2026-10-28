import { Role, Status } from "@prisma/client";
import { integrationPrisma } from "../../testing/integrationDatabase";
import { coopYearBounds } from "../../utils/dateUtils";
import { anyFilters } from "../../utils/recommendation.fixtures";
import { candidateExclusions, fetchRankedCandidates } from "./candidateSearch";
import { coopIsLiveFilter, coopIsLiveSql } from "./coopLiveness";

/**
 * The liveness predicate against real MySQL (SCRUM-631, SCRUM-699).
 *
 * This is the only place the rule can actually be checked. `end_date` is
 * `@db.Date` and each boundary is a timestamp on the Prisma side and a date
 * literal on the raw-SQL side, so what the comparison *means* is decided by
 * MySQL rather than by either of the renderings — and a mocked Prisma would
 * return whatever the test handed it, proving nothing about either. The four
 * floor cases below (ended, ends today, ends tomorrow, no dates) are the
 * entire risk SCRUM-631 identified, and the today case is the one that fails
 * if the comparison is ever flipped to exclusive. The ceiling cases are
 * SCRUM-699's, and the on-the-ceiling case is the one that fails if `lt` is
 * ever written as `lte`.
 *
 * **Needs a real MySQL** and runs only through `yarn test:db`. Fixtures are
 * built per test: `jest.integration.setupAfterEnv.js` truncates every table
 * before each one.
 */

const prisma = integrationPrisma();

/**
 * "Today" for every test here, pinned rather than taken from the clock.
 *
 * Midday UTC, so the UTC day is unambiguous however the suite's `TZ` is set —
 * CI runs it under both UTC and `America/New_York`.
 */
const NOW = new Date("2026-10-27T12:00:00.000Z");

/** A `@db.Date` value, built in UTC the way `lastDayOfMonthUTC` writes one. */
const utcDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

const ENDED = utcDay(2024, 6, 30);
const ENDS_TODAY = utcDay(2026, 10, 27);
const ENDS_TOMORROW = utcDay(2026, 10, 28);

/**
 * The ceiling, derived rather than written: `coopYearBounds`' `latest` is
 * relative to `NOW`, so a literal here would pass today and fail the January
 * the bound moves. `ON_CEILING` is the last day the rule admits and
 * `PAST_CEILING` the first it rejects.
 */
const CEILING_YEAR = coopYearBounds(NOW).latest;
const ON_CEILING = utcDay(CEILING_YEAR, 12, 31);
const PAST_CEILING = utcDay(CEILING_YEAR + 1, 1, 1);

/**
 * The shape SCRUM-699 found in production: a co-op whose two-digit year was
 * pivoted into the 2070s, which "has not ended" and so passed the floor alone.
 */
const PIVOTED = utcDay(2073, 6, 30);

/** An onboarded, ACTIVE user with a search, two locations and a co-op range. */
const seedSearcher = async (
  name: string,
  role: Role,
  dates: { startDate: Date | null; endDate: Date | null },
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
      seatsAvail: role === Role.DRIVER ? 3 : 0,
      homeLocationId: home.id,
      companyLocationId: company.id,
      startDate: dates.startDate,
      endDate: dates.endDate,
    },
  });
  return user;
};

/** The ids the candidate query returns to `userId`, sorted. */
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
    // `dateOverlap: 0` — the default state, and the one that used to offer no
    // protection at all. Every assertion below is therefore about the
    // absolute rule rather than about the searcher's own filter.
    filters: { ...anyFilters(), favorites: false },
    sort: "any",
    excludedUserIds,
    favoriteUserIds: [],
    now: NOW,
  });

  return ranked.map((search) => search.userId).sort();
};

describe("the liveness rule, on the default dateOverlap of 0", () => {
  it("drops a candidate whose co-op ended", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    await seedSearcher("Ended", Role.DRIVER, {
      startDate: utcDay(2024, 1, 31),
      endDate: ENDED,
    });

    expect(await candidateIdsFor(rider.id)).toEqual([]);
  });

  /**
   * The boundary, and the reason the comparison is `gte` rather than `gt`.
   *
   * `end_date` holds the **last day** of the co-op, so a driver whose co-op
   * ends today is driving today. An exclusive comparison drops them a day
   * early, and this is the assertion that fails if anyone writes one.
   */
  it("keeps a candidate whose co-op ends today", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    const endsToday = await seedSearcher("EndsToday", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TODAY,
    });

    expect(await candidateIdsFor(rider.id)).toEqual([endsToday.id]);
  });

  it("keeps a candidate whose co-op ends tomorrow", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    const endsTomorrow = await seedSearcher("EndsTomorrow", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TOMORROW,
    });

    expect(await candidateIdsFor(rider.id)).toEqual([endsTomorrow.id]);
  });

  /**
   * The decision SCRUM-631 left to be made on measurement, pinned so it is a
   * decision rather than an accident of three-valued logic. `coopLiveness.ts`
   * carries the reasoning: on production the dateless rows cost 44 of 1,499
   * matchable rows, because the cohort is overwhelmingly VIEWERs, who are
   * never candidates anyway.
   */
  it("keeps a candidate with no dates stored at all", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    const dateless = await seedSearcher("Dateless", Role.DRIVER, {
      startDate: null,
      endDate: null,
    });

    expect(await candidateIdsFor(rider.id)).toEqual([dateless.id]);
  });

  /**
   * SCRUM-699. The row that motivated the ticket: production held two RIDER
   * searches dated 2069→2073, which the floor alone admits *because* the date
   * is wrong. Seeded as a DRIVER so it is a candidate for the searching rider
   * at all — `compatibleRoles` would not offer a rider to a rider — since the
   * defect is about the date rather than the role.
   */
  it("drops a candidate whose co-op is dated past the year ceiling", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    await seedSearcher("Pivoted", Role.DRIVER, {
      startDate: utcDay(2069, 1, 31),
      endDate: PIVOTED,
    });

    expect(await candidateIdsFor(rider.id)).toEqual([]);
  });

  /**
   * The upper boundary, and the reason the comparison is `lt` against the
   * start of the following year rather than `lte` against the ceiling year.
   *
   * 31 December of `coopYearBounds`' `latest` is the last day the rule admits
   * and 1 January after it the first it rejects. Both are asserted, because a
   * bound that is a year out passes either test on its own.
   */
  it("keeps a candidate ending on the ceiling and drops one a day later", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    const onCeiling = await seedSearcher("OnCeiling", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ON_CEILING,
    });
    await seedSearcher("PastCeiling", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: PAST_CEILING,
    });

    expect(await candidateIdsFor(rider.id)).toEqual([onCeiling.id]);
  });

  it("separates the six cases in one pool rather than one at a time", async () => {
    const rider = await seedSearcher("Rider", Role.RIDER, {
      startDate: utcDay(2026, 9, 1),
      endDate: ENDS_TOMORROW,
    });
    await seedSearcher("Ended", Role.DRIVER, {
      startDate: utcDay(2024, 1, 31),
      endDate: ENDED,
    });
    await seedSearcher("Pivoted", Role.DRIVER, {
      startDate: utcDay(2069, 1, 31),
      endDate: PIVOTED,
    });
    const endsToday = await seedSearcher("EndsToday", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TODAY,
    });
    const endsTomorrow = await seedSearcher("EndsTomorrow", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TOMORROW,
    });
    const dateless = await seedSearcher("Dateless", Role.DRIVER, {
      startDate: null,
      endDate: null,
    });
    const onCeiling = await seedSearcher("OnCeiling", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ON_CEILING,
    });

    expect(await candidateIdsFor(rider.id)).toEqual(
      [endsToday.id, endsTomorrow.id, dateless.id, onCeiling.id].sort(),
    );
  });
});

/**
 * The anti-drift control the two renderings exist under.
 *
 * `coopLiveness.ts` has to express the same rule twice — a Prisma `where` for
 * the candidate query and a raw fragment for the admin supply counter, which
 * is raw because Prisma's `groupBy` cannot group by a related table's column.
 * Sitting next to each other in one file is not what keeps them equal; this
 * is. It compares the row sets they actually select from the same table, so a
 * change to one that the other does not follow fails here.
 */
describe("the Prisma and raw-SQL renderings select the same rows", () => {
  it("agree across ended, today, tomorrow, dateless and both ceiling sides", async () => {
    await seedSearcher("Ended", Role.DRIVER, {
      startDate: utcDay(2024, 1, 31),
      endDate: ENDED,
    });
    await seedSearcher("EndsToday", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TODAY,
    });
    await seedSearcher("EndsTomorrow", Role.RIDER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TOMORROW,
    });
    await seedSearcher("Dateless", Role.RIDER, {
      startDate: null,
      endDate: null,
    });
    await seedSearcher("OnCeiling", Role.RIDER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ON_CEILING,
    });
    await seedSearcher("PastCeiling", Role.RIDER, {
      startDate: utcDay(2026, 8, 31),
      endDate: PAST_CEILING,
    });

    const viaPrisma = await prisma.carpoolSearch.findMany({
      where: coopIsLiveFilter(NOW),
      select: { id: true },
    });

    const viaSql = await prisma.$queryRaw<{ id: string }[]>`
      SELECT cs.id FROM carpool_search cs WHERE ${coopIsLiveSql("cs", NOW)}
    `;

    const prismaIds = viaPrisma.map((row) => row.id).sort();

    // Four of the six, so an accidental "select everything" on either side is
    // a failure here rather than a pair that agrees on the wrong answer.
    expect(prismaIds).toHaveLength(4);
    expect(viaSql.map((row) => row.id).sort()).toEqual(prismaIds);
  });

  /**
   * The ceiling gets its own aggregate probe for the reason the floor does:
   * the Prisma side binds a timestamp against a DATE column, so only MySQL
   * can settle which calendar day the bound landed on. `MAX` rather than the
   * floor's `MIN`, because it is the upper bound being read back.
   */
  it("put the ceiling on the same calendar day MySQL sees", async () => {
    await seedSearcher("OnCeiling", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ON_CEILING,
    });
    await seedSearcher("PastCeiling", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: PAST_CEILING,
    });

    const [{ ceiling }] = await prisma.$queryRaw<{ ceiling: Date }[]>`
      SELECT MAX(cs.end_date) AS ceiling FROM carpool_search cs
      WHERE ${coopIsLiveSql("cs", NOW)}
    `;

    expect(ceiling).toEqual(ON_CEILING);
  });

  /**
   * `end_date` is a DATE column and the Prisma side binds a timestamp, so this
   * asserts MySQL resolves that boundary to the day meant rather than to the
   * day either side of it — the coercion SCRUM-631 flagged and the one thing
   * neither rendering can settle on its own.
   */
  it("put the boundary on the same calendar day MySQL sees", async () => {
    await seedSearcher("EndsToday", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TODAY,
    });

    const [{ boundary }] = await prisma.$queryRaw<{ boundary: Date }[]>`
      SELECT MIN(cs.end_date) AS boundary FROM carpool_search cs
      WHERE ${coopIsLiveSql("cs", NOW)}
    `;

    expect(boundary).toEqual(ENDS_TODAY);
  });

  /**
   * The predicate is `AND`ed into a `WHERE` that already has terms, so each
   * internal `OR` has to be parenthesised — and since SCRUM-699 there are two
   * of them, inside one further pair of brackets. Without the brackets an
   * `OR` binds looser than the surrounding `AND` and its dateless arm pulls in
   * rows the other conditions excluded — a far wider result than intended, and
   * one that looks plausible until someone counts it.
   */
  it("does not escape the surrounding AND", async () => {
    await seedSearcher("EndedDriver", Role.DRIVER, {
      startDate: utcDay(2024, 1, 31),
      endDate: ENDED,
    });
    await seedSearcher("PastCeilingDriver", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: PAST_CEILING,
    });
    await seedSearcher("DatelessRider", Role.RIDER, {
      startDate: null,
      endDate: null,
    });
    const live = await seedSearcher("LiveDriver", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TOMORROW,
    });

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT cs.id FROM carpool_search cs
      WHERE cs.role = ${Role.DRIVER} AND ${coopIsLiveSql("cs", NOW)}
    `;

    const liveSearch = await prisma.carpoolSearch.findFirstOrThrow({
      where: { userId: live.id },
      select: { id: true },
    });

    expect(rows.map((row) => row.id)).toEqual([liveSearch.id]);
  });
});

/**
 * The admin supply counter reads the same predicate, which is the half of
 * SCRUM-631 that keeps the dashboard and the match pool telling the same
 * story. Asserted against the shape of that query rather than through the
 * router, so it does not need an admin session to be meaningful.
 */
describe("the admin supply counter counts the same population", () => {
  it("excludes an ended and an over-dated co-op from a city's totals", async () => {
    await seedSearcher("EndedDriver", Role.DRIVER, {
      startDate: utcDay(2024, 1, 31),
      endDate: ENDED,
    });
    await seedSearcher("PivotedDriver", Role.DRIVER, {
      startDate: utcDay(2069, 1, 31),
      endDate: PIVOTED,
    });
    await seedSearcher("LiveDriver", Role.DRIVER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TOMORROW,
    });
    await seedSearcher("LiveRider", Role.RIDER, {
      startDate: utcDay(2026, 8, 31),
      endDate: ENDS_TODAY,
    });

    const supply = await prisma.$queryRaw<
      { city: string; drivers: bigint; riders: bigint; openSeats: bigint }[]
    >`
        SELECT
          LOWER(TRIM(COALESCE(l.city, ''))) AS city,
          CAST(SUM(cs.role = ${Role.DRIVER}) AS SIGNED) AS drivers,
          CAST(SUM(cs.role = ${Role.RIDER}) AS SIGNED) AS riders,
          CAST(
            SUM(CASE WHEN cs.role = ${Role.DRIVER} AND cs.seats_avail > 0
              THEN cs.seats_avail ELSE 0 END) AS SIGNED
          ) AS openSeats
        FROM carpool_search cs
        INNER JOIN user u ON u.id = cs.userId AND u.email IS NOT NULL
        LEFT JOIN location l ON l.id = cs.homeLocationId
        WHERE cs.status = ${Status.ACTIVE}
          AND cs.role IN (${Role.DRIVER}, ${Role.RIDER})
          AND ${coopIsLiveSql("cs", NOW)}
        GROUP BY LOWER(TRIM(COALESCE(l.city, '')))
      `;

    expect(
      supply.map((row) => ({
        city: row.city,
        drivers: Number(row.drivers),
        riders: Number(row.riders),
        openSeats: Number(row.openSeats),
      })),
    ).toEqual([{ city: "somerville", drivers: 1, riders: 1, openSeats: 3 }]);
  });
});
