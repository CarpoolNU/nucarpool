/**
 * Report `CarpoolSearch` rows that are silently unmatchable (SCRUM-302).
 *
 * `user.edit` used to accept any number as a coordinate and any pair of co-op
 * dates in any order. Neither is rejected by the columns — `coord_lat` /
 * `coord_lng` are plain `Float`, `start_date` / `end_date` are independent
 * `Date` — and neither fails at save time. They fail later, inside matching,
 * where nothing reports:
 *
 * - **Unresolved coordinates.** `(0, 0)` is the "no address picked yet"
 *   sentinel from `useAddressSelection`, roughly 4000 miles from Boston.
 *   `locationWithin` centres its bounding box there and `milesBetween` measures
 *   from there, so the row appears in no distance-filtered search.
 * - **Out-of-range coordinates.** Outside WGS 84 the same two functions return
 *   arbitrary answers rather than failing, and the `location_coord_lat_coord_lng_idx`
 *   bounding-box query added in SCRUM-245 is scanned for nothing.
 * - **Reversed co-op ranges.** `dateOverlapFilter`'s full-overlap branch wants
 *   `startDate <= theirs AND endDate >= theirs`, which no candidate satisfies
 *   once the two are crossed. The partial-overlap negation is arbitrary.
 *
 * **Read-only. This script writes nothing.**
 *
 * That is the right shape for it. There is no correct value to write: a bad
 * coordinate cannot be re-derived without re-geocoding an address string that
 * may itself be empty, and only the student knows which way round their co-op
 * runs. What a fix looks like is an email asking the affected users to re-save
 * their profile, which the boundary now validates. So this answers "does the
 * backfill on the ticket have anything to do", and the remedy stays a human
 * decision — the same reasoning as `check-self-requests.ts`.
 *
 * A VIEWER at `(0, 0)` is **not** a finding. A VIEWER is browsing rather than
 * matching, has no address to resolve, and `user.me` already reports `(0, 0)`
 * for a row with no `Location`; `user.edit` deliberately still permits it.
 * Counting them would bury the real findings.
 *
 * Usage:
 *   npx ts-node scripts/check-profile-coordinates.ts
 *
 * Confirm `DATABASE_URL` points where you intend first. Exits 0 when the
 * database is clean and 1 when it is not, so it can gate a follow-up.
 */

import { PrismaClient, Role } from "@prisma/client";
import {
  MAX_LATITUDE,
  MAX_LONGITUDE,
  MIN_LATITUDE,
  MIN_LONGITUDE,
  isUnresolvedCoordinate,
} from "../src/utils/coordinates";
import { isReversedCoopRange } from "../src/utils/dateUtils";

/** The two `Location` slots of a search, as much as the check reads. */
type LocationSlot = {
  id: string;
  streetAddress: string;
  coordLng: number;
  coordLat: number;
} | null;

export type SearchRow = {
  id: string;
  userId: string;
  role: Role;
  startDate: Date | null;
  endDate: Date | null;
  homeLocation: LocationSlot;
  companyLocation: LocationSlot;
};

export type Finding = {
  searchId: string;
  userId: string;
  role: Role;
  /** One human-readable line per problem, in a stable order. */
  problems: string[];
};

const inRange = (lng: number, lat: number): boolean =>
  lng >= MIN_LONGITUDE &&
  lng <= MAX_LONGITUDE &&
  lat >= MIN_LATITUDE &&
  lat <= MAX_LATITUDE;

const describeSlot = (
  slot: LocationSlot,
  label: "home" | "company",
  role: Role,
): string[] => {
  // `relationMode = "prisma"` emulates the foreign key, so a search can point
  // at a Location id that no longer exists. Worth reporting rather than
  // skipping: the row is just as unmatchable.
  if (!slot) {
    return [`${label} location row is missing`];
  }

  const at = `(${slot.coordLng}, ${slot.coordLat})`;

  if (!inRange(slot.coordLng, slot.coordLat)) {
    return [`${label} coordinates out of range ${at}`];
  }

  if (
    isUnresolvedCoordinate(slot.coordLng, slot.coordLat) &&
    role !== Role.VIEWER
  ) {
    const address = slot.streetAddress || "(no address stored)";
    return [`${label} coordinates unresolved ${at} for "${address}"`];
  }

  return [];
};

/**
 * Every problem the check knows how to name, per search. Pure, so the reporting
 * half can be exercised without a database.
 */
export const findProfileDataProblems = (
  searches: readonly SearchRow[],
): Finding[] =>
  searches
    .map((search) => ({
      searchId: search.id,
      userId: search.userId,
      role: search.role,
      problems: [
        ...describeSlot(search.homeLocation, "home", search.role),
        ...describeSlot(search.companyLocation, "company", search.role),
        ...(isReversedCoopRange(search.startDate, search.endDate)
          ? [
              `co-op range reversed: ` +
                `${search.startDate?.toISOString().slice(0, 10)} to ` +
                `${search.endDate?.toISOString().slice(0, 10)}`,
            ]
          : []),
      ],
    }))
    .filter((finding) => finding.problems.length > 0);

const main = async () => {
  if (process.argv.length > 2) {
    throw new Error(
      `unexpected argument(s): ${process.argv.slice(2).join(", ")}. ` +
        `This script takes none and only reads.`,
    );
  }

  const prisma = new PrismaClient();

  try {
    const searches = await prisma.carpoolSearch.findMany({
      select: {
        id: true,
        userId: true,
        role: true,
        startDate: true,
        endDate: true,
        homeLocation: {
          select: {
            id: true,
            streetAddress: true,
            coordLng: true,
            coordLat: true,
          },
        },
        companyLocation: {
          select: {
            id: true,
            streetAddress: true,
            coordLng: true,
            coordLat: true,
          },
        },
      },
    });

    const findings = findProfileDataProblems(searches);

    console.log(`${searches.length} carpool_search row(s)`);
    console.log(`${findings.length} row(s) with a problem`);

    if (findings.length === 0) {
      console.log(
        "\n✓ every search has in-range, resolved coordinates and a forward " +
          "co-op range.",
      );
      return;
    }

    for (const finding of findings) {
      console.log(
        `\n    search ${finding.searchId}` +
          `\n    user   ${finding.userId} (${finding.role})` +
          finding.problems.map((problem) => `\n    - ${problem}`).join(""),
      );
    }

    console.log(
      `\n✖ These rows are excluded from searches they should appear in. ` +
        `Nothing here is safe to guess at: ask the affected users to re-save ` +
        `their profile, which is now validated at the boundary.`,
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
};

// Guarded so the test can import findProfileDataProblems without opening a
// database connection.
if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
