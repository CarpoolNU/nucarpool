/**
 * Report `CarpoolSearch` rows that are silently unmatchable.
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
 *   bounding-box query is scanned for nothing.
 * - **Reversed co-op ranges.** `dateOverlapFilter`'s full-overlap branch wants
 *   `startDate <= theirs AND endDate >= theirs`, which no candidate satisfies
 *   once the two are crossed. The partial-overlap negation is arbitrary.
 * - **Implausible co-op years** (SCRUM-550). A range like 1901→1908 runs
 *   forwards, so the check above passes it, and it then fails every
 *   term-date-overlap search. Bounded by `coopYearBounds`; a VIEWER is not a
 *   finding, for the reason `implausibleCoopYearFields` gives.
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
 * ## Two populations, one of them not a defect (SCRUM-408)
 *
 * A user who picks `RIDER` during onboarding and abandons it before resolving
 * an address leaves exactly the shape the coordinate check looks for: role
 * `RIDER`, coordinates `(0, 0)`, `is_onboarded = false`. That row is an
 * unfinished sign-up rather than an unmatchable user — it was never in
 * matching, so it cannot have been excluded from it.
 *
 * On production that is 579 of 626 reported rows, and on staging all 521 of
 * them. Exiting `1` on the total made the gate permanently red, which gates
 * nothing and buried the 47 rows that do need action.
 *
 * So every finding is still reported, and each carries `actionable`:
 *
 * - **Not actionable**: the `(0, 0)` sentinel on a search whose user never
 *   finished onboarding. Counted and named in the output, never in the exit
 *   code.
 * - **Actionable**: everything else, which is deliberately everything else.
 *   Out-of-range coordinates and a missing `location` row are not explained by
 *   an abandoned sign-up whoever owns them, and a **reversed co-op range stays
 *   actionable regardless of onboarding state or `status`** — the dates are
 *   wrong now and nothing corrects them when that search goes live. 7 of
 *   production's 47 are not `ACTIVE`, and a search reactivates without its
 *   dates being touched.
 *
 * Usage:
 *   npx ts-node scripts/check-profile-coordinates.ts
 *
 * Confirm `DATABASE_URL` points where you intend first. Exits 0 when there is
 * nothing actionable and 1 when there is, so it can gate a follow-up.
 */

import { PrismaClient, Role } from "@prisma/client";
import {
  MAX_LATITUDE,
  MAX_LONGITUDE,
  MIN_LATITUDE,
  MIN_LONGITUDE,
  isUnresolvedCoordinate,
} from "../src/utils/coordinates";
import {
  coopYearBounds,
  implausibleCoopYearFields,
  isReversedCoopRange,
} from "../src/utils/dateUtils";

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
  /** `user.is_onboarded`, joined. See the two-populations note above. */
  isOnboarded: boolean;
  startDate: Date | null;
  endDate: Date | null;
  homeLocation: LocationSlot;
  companyLocation: LocationSlot;
};

/**
 * One problem line and whether it is something to act on, kept together so the
 * two cannot drift apart. Internal: callers get the descriptions and one
 * `actionable` flag per finding, which is the granularity the report and the
 * exit code both work at.
 */
type TaggedProblem = {
  description: string;
  actionable: boolean;
};

export type Finding = {
  searchId: string;
  userId: string;
  role: Role;
  isOnboarded: boolean;
  /** One human-readable line per problem, in a stable order. */
  problems: string[];
  /**
   * True when at least one of `problems` needs action. The exit code is keyed
   * to this and to nothing else.
   */
  actionable: boolean;
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
  isOnboarded: boolean,
): TaggedProblem[] => {
  // `relationMode = "prisma"` emulates the foreign key, so a search can point
  // at a Location id that no longer exists. Worth reporting rather than
  // skipping: the row is just as unmatchable.
  if (!slot) {
    return [
      { description: `${label} location row is missing`, actionable: true },
    ];
  }

  const at = `(${slot.coordLng}, ${slot.coordLat})`;

  if (!inRange(slot.coordLng, slot.coordLat)) {
    return [
      {
        description: `${label} coordinates out of range ${at}`,
        actionable: true,
      },
    ];
  }

  if (
    isUnresolvedCoordinate(slot.coordLng, slot.coordLat) &&
    role !== Role.VIEWER
  ) {
    const address = slot.streetAddress || "(no address stored)";
    return [
      {
        description: `${label} coordinates unresolved ${at} for "${address}"`,
        // The one problem onboarding state decides. Still reported either way.
        actionable: isOnboarded,
      },
    ];
  }

  return [];
};

/**
 * Every problem the check knows how to name, per search. Pure, so the reporting
 * half can be exercised without a database.
 *
 * Both populations come back from one pass, tagged rather than filtered — a
 * caller that wants only the actionable set filters on `actionable`, and the
 * count of what it dropped is still there to print.
 */
export const findProfileDataProblems = (
  searches: readonly SearchRow[],
  now: Date = new Date(),
): Finding[] => {
  const { earliest, latest } = coopYearBounds(now);

  return searches
    .map((search) => {
      const problems: TaggedProblem[] = [
        ...describeSlot(
          search.homeLocation,
          "home",
          search.role,
          search.isOnboarded,
        ),
        ...describeSlot(
          search.companyLocation,
          "company",
          search.role,
          search.isOnboarded,
        ),
        // Unconditionally actionable: a crossed range is wrong on its own
        // terms, and an unfinished sign-up that resumes carries it into
        // matching untouched.
        ...(isReversedCoopRange(search.startDate, search.endDate)
          ? [
              {
                description:
                  `co-op range reversed: ` +
                  `${search.startDate?.toISOString().slice(0, 10)} to ` +
                  `${search.endDate?.toISOString().slice(0, 10)}`,
                actionable: true,
              },
            ]
          : []),
        // Actionable for the same reason as the line above. A VIEWER is not a
        // finding, exactly as a VIEWER at `(0, 0)` is not: see
        // `implausibleCoopYearFields`, which both schemas use too.
        ...(implausibleCoopYearFields({
          role: search.role,
          coopStartDate: search.startDate,
          coopEndDate: search.endDate,
          now,
        }).length > 0
          ? [
              {
                description:
                  `co-op year implausible: ` +
                  `${search.startDate?.toISOString().slice(0, 10)} to ` +
                  `${search.endDate?.toISOString().slice(0, 10)} ` +
                  `(allowed ${earliest}–${latest})`,
                actionable: true,
              },
            ]
          : []),
      ];

      return {
        searchId: search.id,
        userId: search.userId,
        role: search.role,
        isOnboarded: search.isOnboarded,
        problems: problems.map((problem) => problem.description),
        actionable: problems.some((problem) => problem.actionable),
      };
    })
    .filter((finding) => finding.problems.length > 0);
};

/**
 * The exit status for a run, from the findings alone.
 *
 * Separate from `main` so the gate is testable without a database, and called
 * by `main` rather than re-derived there, so the contract the test pins is the
 * one an operator gets.
 */
export const exitCodeFor = (findings: readonly Finding[]): 0 | 1 =>
  findings.some((finding) => finding.actionable) ? 1 : 0;

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
        // Decides whether a `(0, 0)` row is a defect or an abandoned sign-up.
        // `status` is deliberately not read: see the note at the top.
        user: {
          select: {
            isOnboarded: true,
          },
        },
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

    const findings = findProfileDataProblems(
      searches.map(({ user, ...search }) => ({
        ...search,
        // `relationMode = "prisma"` emulates this foreign key too, so the join
        // can come back empty even though the schema declares the relation
        // required. A search with no user row counts as onboarded: that keeps
        // it in the actionable set rather than quietly excusing a row nobody
        // can explain.
        isOnboarded: user?.isOnboarded ?? true,
      })),
    );

    const actionable = findings.filter((finding) => finding.actionable);
    const excluded = findings.filter((finding) => !finding.actionable);

    // Taken from the tested function rather than recomputed here.
    process.exitCode = exitCodeFor(findings);

    console.log(`${searches.length} carpool_search row(s)`);
    console.log(`${findings.length} row(s) with a problem`);
    console.log(`${actionable.length} actionable`);

    if (excluded.length > 0) {
      console.log(
        `${excluded.length} not actionable: the (0, 0) sentinel on a search ` +
          `whose user never finished onboarding, so it was never in matching`,
      );
    }

    if (actionable.length === 0) {
      console.log(
        "\n✓ every search belonging to an onboarded user has in-range, " +
          "resolved coordinates, and no search has a reversed co-op range " +
          "or an implausible co-op year.",
      );
      if (excluded.length > 0) {
        console.log(
          `  The ${excluded.length} row(s) above need nothing until those ` +
            `users come back and finish onboarding, at which point the form ` +
            `makes them resolve an address.`,
        );
      }
      return;
    }

    for (const finding of actionable) {
      console.log(
        `\n    search ${finding.searchId}` +
          `\n    user   ${finding.userId} (${finding.role}` +
          `${finding.isOnboarded ? "" : ", not onboarded"})` +
          finding.problems.map((problem) => `\n    - ${problem}`).join(""),
      );
    }

    console.log(
      `\n✖ These rows are excluded from searches they should appear in. ` +
        `Nothing here is safe to guess at: ask the affected users to re-save ` +
        `their profile, which is now validated at the boundary.`,
    );
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
