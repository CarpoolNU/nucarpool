/**
 * Measures rows read by the explore page's candidate query, before and after
 *
 * The ticket asks for rows read per explore page load, measured both ways. That
 * cannot be done from the repository alone: a developer's local database holds a
 * row or two, so the numbers only mean something against a database with real
 * data. This script exists so the measurement is reproducible by whoever has
 * that access, rather than being a number someone quotes once.
 *
 * It is **read-only** — `findMany` and `count`, no writes of any kind — and it
 * never prints the connection string.
 *
 * Both matching endpoints run on one explore page load with the same filters, so
 * a page load costs twice what one query below reports. The doubling is applied
 * in the summary.
 *
 * Two scenarios are reported, because they differ a lot and quoting only the
 * better one would overstate the change:
 *
 *   - **initial load** — the filter state `src/pages/index.tsx` actually sends
 *     first: distances at 20 ("any"), no date requirement. No bounding box
 *     applies, so the saving comes from role, seats and the `take` bound alone.
 *   - **narrowed** — distances at 6 miles, the scorer's own default cutoffs.
 *     This is where the bounding box does its work.
 *
 * **Then a third thing, and the one with a decision attached: headroom.**
 * `CANDIDATE_LIMIT` is a cost bound that does not degrade gracefully — past it
 * rows are dropped in id order, not by score — so what matters is not the
 * saving but how close the widest query is to the ceiling. The two scenarios
 * above cannot answer that, for two reasons that both point the same way:
 *
 *   - They measure **one** subject, chosen as a RIDER or a DRIVER because a
 *     VIEWER "would understate the change". For the saving that is the right
 *     choice. For the ceiling it is the wrong one exactly backwards: a VIEWER
 *     is filtered least, so a VIEWER *is* the worst case.
 *   - They report a reduction, never a percentage of `CANDIDATE_LIMIT`.
 *
 * So `measureHeadroom` below reports all three searcher roles at their widest
 * filters, against the ceiling. It builds its `where` through the real
 * `buildCandidateWhere` rather than restating the predicate, so it cannot
 * drift from what the app runs — the same rule `SEAT_AVAILABLE_FILTER` and
 * `UNGROUPED_CANDIDATE_FILTER` exist to enforce.
 *
 * Usage:
 *   npx ts-node scripts/measure-candidate-rows.ts
 *   npx ts-node scripts/measure-candidate-rows.ts --user <userId>
 *
 * Confirm DATABASE_URL points where you intend before running. Pointing it at
 * production is safe — nothing is written — but the numbers are only meaningful
 * against a database with representative data.
 *
 * **Run it against the environment you care about, and do not reuse a figure
 * from another one.** `staging` is production-derived but much smaller, and
 * reading its numbers as production's is the specific mistake SCRUM-643 found:
 * on 2026-10-08 the worst case was 751 rows on `staging` and 1,463 on
 * production, which is 38% of the ceiling against 73%. Record what you measure
 * per "Has a script been applied to staging or production?" in
 * scripts/README.md.
 */

import { PrismaClient, Prisma, Role, Status } from "@prisma/client";
import {
  buildCandidateWhere,
  candidateInclude,
  CANDIDATE_LIMIT,
} from "../src/server/db/candidateSearch";
import type { FInputs } from "../src/utils/recommendation";

/**
 * The `where` both endpoints built before this change, kept verbatim so the
 * comparison is against what actually shipped rather than a reconstruction.
 * It was typed `any` in both routers; that is the point of AC 4.
 */
const legacyWhere = (
  excludedUserIds: string[],
): Prisma.CarpoolSearchWhereInput => ({
  userId: { notIn: excludedUserIds },
  status: Status.ACTIVE,
  user: { isOnboarded: true },
});

export type RowCounts = {
  carpoolSearch: number;
  location: number;
  user: number;
  total: number;
};

/**
 * Rows the query pulled back, by table.
 *
 * `include` is a separate query per relation under `relationMode = "prisma"`,
 * so the location and user rows are real reads rather than free join output.
 * Locations are counted distinctly because Prisma fetches them with one
 * `IN (...)` per relation.
 */
export const countRows = (
  rows: { userId: string; homeLocationId: string; companyLocationId: string }[],
): RowCounts => {
  const locationIds = new Set<string>();
  for (const row of rows) {
    locationIds.add(row.homeLocationId);
    locationIds.add(row.companyLocationId);
  }

  const carpoolSearch = rows.length;
  const location = locationIds.size;
  const user = rows.length;

  return {
    carpoolSearch,
    location,
    user,
    total: carpoolSearch + location + user,
  };
};

/** Percentage reduction from `before` to `after`, floored at 0. */
export const reduction = (before: number, after: number): number => {
  if (before <= 0) return 0;
  return Math.max(0, Math.round(((before - after) / before) * 100));
};

/**
 * The widest possible searcher of each role, as `buildCandidateWhere` reads one.
 *
 * Synthetic rather than loaded from the database, and that is the point: the
 * ceiling question is "how large can the candidate set get for *anybody* in
 * this role", not "how large is it for the first matching row". A real subject
 * would carry coordinates, and coordinates mean a bounding box.
 *
 * Both locations are `null`, which `locationWithin` reads as "no centre, so
 * SQL must not narrow" — the same branch a distance slider at `any` takes. So
 * these three are the unfiltered pools, which is what the ceiling applies to.
 *
 * The two non-obvious fields each disarm one half of `searcherCanMatchNobody`,
 * which would otherwise empty the result set before a single candidate is
 * looked at:
 *
 *   - `carpoolId: null` — a grouped RIDER can join nobody.
 *   - `seatsAvail: 1` for the DRIVER — a DRIVER with no seat can take nobody.
 *
 * A VIEWER is subject to neither rule and to no seat or group narrowing at
 * all, which is why a VIEWER is the worst case rather than merely another one.
 */
export const WIDEST_SUBJECTS = [
  { role: Role.RIDER, carpoolId: null, seatsAvail: 0 },
  { role: Role.DRIVER, carpoolId: null, seatsAvail: 1 },
  { role: Role.VIEWER, carpoolId: null, seatsAvail: 0 },
].map((subject) => ({
  ...subject,
  homeLocation: null,
  companyLocation: null,
}));

/** Filters with every narrowing switched off: distances "any", no date rule. */
export const widestFilters = (): FInputs & { favorites: boolean } => ({
  ...baseFilters({}),
  favorites: false,
});

export type Headroom = {
  role: Role;
  rows: number;
  /** `rows` as a percentage of `CANDIDATE_LIMIT`, rounded. */
  percentOfLimit: number;
  /**
   * How much the matchable population must grow before this role's query
   * truncates, as a percentage. `null` once it already has — at that point
   * growth is not the question any more.
   */
  growthToBreach: number | null;
};

/**
 * Headroom for one measured pool.
 *
 * Separated from the query so the arithmetic is testable without a database,
 * which is the half that can be wrong in a way nobody notices: a percentage
 * reported against the wrong denominator still looks like a percentage.
 *
 * `rows` is the count the ceiling actually applies to — `carpool_search` rows.
 * Not `RowCounts.total`, which adds the user and location rows the `include`
 * pulls along. Those are real reads and the scenarios above are right to count
 * them, but `take: CANDIDATE_LIMIT` bounds the search rows alone, so measuring
 * the bound against a total that is roughly four times larger would report the
 * ceiling as breached long before it is.
 */
export const headroom = (role: Role, rows: number): Headroom => ({
  role,
  rows,
  percentOfLimit: Math.round((rows / CANDIDATE_LIMIT) * 100),
  growthToBreach:
    rows > CANDIDATE_LIMIT
      ? null
      : Math.round((CANDIDATE_LIMIT / Math.max(rows, 1) - 1) * 100),
});

const SCENARIOS: { name: string; filters: Partial<FInputs> }[] = [
  {
    name: "initial load (distances any, no date filter)",
    filters: { startDistance: 20, endDistance: 20, dateOverlap: 0 },
  },
  {
    name: "narrowed (6 miles, partial date overlap)",
    filters: { startDistance: 6, endDistance: 6, dateOverlap: 1 },
  },
];

const baseFilters = (overrides: Partial<FInputs>): FInputs => ({
  startDistance: 20,
  endDistance: 20,
  startTime: 4,
  endTime: 4,
  days: 0,
  flexDays: 0,
  startDate: new Date(),
  endDate: new Date(),
  dateOverlap: 0,
  daysWorking: "0,1,1,1,1,1,0",
  ...overrides,
});

/**
 * Rows the widest query of each searcher role would read, against the ceiling.
 *
 * `count` rather than `findMany`: the ceiling is about how many rows *exist*
 * for the predicate, and `findMany` with `take` would cap the answer at the
 * very number being tested. No `include` either — see `headroom`.
 */
export const measureHeadroom = async (prisma: {
  carpoolSearch: {
    count: (args: {
      where: Prisma.CarpoolSearchWhereInput;
    }) => PromiseLike<number>;
  };
}): Promise<Headroom[]> => {
  const filters = widestFilters();

  return Promise.all(
    WIDEST_SUBJECTS.map(async (subject) =>
      headroom(
        subject.role,
        await prisma.carpoolSearch.count({
          where: buildCandidateWhere({
            currentSearch: subject,
            filters,
            // Nobody excluded. A real caller excludes at least themselves, so
            // this overstates by one row per blocked or already-messaged
            // counterpart — the direction that cannot report false headroom.
            excludedUserIds: [],
            favoriteUserIds: [],
          }),
        }),
      ),
    ),
  );
};

const formatHeadroom = (results: Headroom[]) => {
  console.log(`headroom against CANDIDATE_LIMIT (${CANDIDATE_LIMIT})`);

  for (const result of results) {
    const growth =
      result.growthToBreach === null
        ? "ALREADY TRUNCATING — rows past the ceiling are dropped in id order"
        : `needs +${result.growthToBreach}% growth to truncate`;

    console.log(
      `  a ${result.role} sees ${result.rows} rows ` +
        `(${result.percentOfLimit}% of the ceiling, ${growth})`,
    );
  }

  const worst = results.reduce((a, b) => (b.rows > a.rows ? b : a));
  console.log(
    `  worst case: ${worst.role}, ${worst.rows} rows, ` +
      `${worst.percentOfLimit}% of the ceiling`,
  );
  console.log();
};

const format = (label: string, counts: RowCounts) => {
  console.log(`  ${label}`);
  console.log(`    carpool_search rows : ${counts.carpoolSearch}`);
  console.log(`    location rows       : ${counts.location}`);
  console.log(`    user rows           : ${counts.user}`);
  console.log(`    total               : ${counts.total}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const userFlag = args.indexOf("--user");
  const requestedUserId = userFlag === -1 ? undefined : args[userFlag + 1];

  const prisma = new PrismaClient();

  try {
    // A VIEWER is filtered least, so measuring one would understate the change.
    // Prefer a real role unless the caller named a user.
    const subject = requestedUserId
      ? await prisma.carpoolSearch.findFirst({
          where: { userId: requestedUserId },
          include: { homeLocation: true, companyLocation: true },
        })
      : await prisma.carpoolSearch.findFirst({
          where: {
            status: Status.ACTIVE,
            role: { in: [Role.RIDER, Role.DRIVER] },
            user: { isOnboarded: true },
          },
          include: { homeLocation: true, companyLocation: true },
        });

    if (!subject) {
      console.log(
        "No suitable CarpoolSearch found. This database has no onboarded rider or driver to measure for.",
      );
      return;
    }

    const [totalSearches, activeSearches] = await Promise.all([
      prisma.carpoolSearch.count(),
      prisma.carpoolSearch.count({ where: { status: Status.ACTIVE } }),
    ]);

    console.log(
      `database: ${totalSearches} carpool searches, ${activeSearches} active`,
    );
    console.log(
      `measured for: role ${subject.role}, take bound ${CANDIDATE_LIMIT}`,
    );
    console.log();

    // First, because it is the number with a decision attached. The before/after
    // scenarios below describe a change that already shipped; this one says
    // whether the bound that change introduced is still comfortable.
    formatHeadroom(await measureHeadroom(prisma));

    const excludedUserIds = [subject.userId];

    for (const scenario of SCENARIOS) {
      const filters = baseFilters(scenario.filters);

      const before = await prisma.carpoolSearch.findMany({
        where: legacyWhere(excludedUserIds),
        include: candidateInclude,
      });

      const after = await prisma.carpoolSearch.findMany({
        where: buildCandidateWhere({
          currentSearch: subject,
          filters: { ...filters, favorites: false },
          excludedUserIds,
          favoriteUserIds: [],
        }),
        include: candidateInclude,
        take: CANDIDATE_LIMIT,
      });

      const beforeCounts = countRows(before);
      const afterCounts = countRows(after);

      console.log(scenario.name);
      format("before (unbounded)", beforeCounts);
      format("after  (bounded)", afterCounts);
      console.log(
        `    reduction           : ${reduction(beforeCounts.total, afterCounts.total)}% fewer rows`,
      );
      console.log(
        `    per page load       : ${beforeCounts.total * 2} -> ${afterCounts.total * 2} (both endpoints run)`,
      );
      console.log();
    }

    console.log(
      "Rows above are rows returned. Without an index, MySQL examines more than it\n" +
        "returns and PlanetScale bills the examined rows -- which is what the\n" +
        "carpool_search(status, role) and location(coord_lat, coord_lng) indexes in\n" +
        "20260827130000_add_matching_query_indexes address. Confirm with EXPLAIN or\n" +
        "PlanetScale's own query insights.",
    );
  } finally {
    await prisma.$disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
