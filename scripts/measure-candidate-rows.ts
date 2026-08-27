/**
 * Measures rows read by the explore page's candidate query, before and after
 * SCRUM-245.
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
 * Usage:
 *   npx ts-node scripts/measure-candidate-rows.ts
 *   npx ts-node scripts/measure-candidate-rows.ts --user <userId>
 *
 * Confirm DATABASE_URL points where you intend before running. Pointing it at
 * production is safe — nothing is written — but the numbers are only meaningful
 * against a database with representative data.
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
