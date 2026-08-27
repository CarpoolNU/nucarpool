import { Prisma, Role, Status } from "@prisma/client";
import _ from "lodash";
import {
  MILES_PER_DEGREE_LATITUDE,
  calculateScore,
} from "../../utils/recommendation";
import type { FInputs, Recommendation } from "../../utils/recommendation";
import type { PrismaOrTransaction } from "./client";

/**
 * The candidate query behind both matching endpoints (SCRUM-245).
 *
 * `mapbox.geoJsonUserList` and `user.recommendations.me` used to hold two
 * near-identical copies of this: fetch *every* ACTIVE carpool search with its
 * user and both location rows, score the whole table in JavaScript, sort, then
 * slice to 150 or 50. Nothing beyond `status` and an exclusion list reached
 * SQL, there was no `take`, and both endpoints run on the same explore page
 * load with the same filters — so every filter interaction read the entire
 * table twice. On PlanetScale, where billing is per row read, that is a direct
 * cost (SCRUM-176).
 *
 * The rule here is that SQL narrows and `calculateScore` decides. Every
 * predicate below must be a **superset** of what the scorer would keep: it may
 * only remove rows the scorer is guaranteed to reject anyway. That is what
 * makes this a performance change rather than a behavioural one, and it is why
 * the mirrored filters are written to match `calculateScore` exactly rather
 * than to a tidier equivalent.
 *
 * Deliberately *not* pushed down:
 *
 *   - **Time of day.** `startTime`/`endTime` are `@db.Time(0)` with a known
 *     storage ambiguity (SCRUM-239), and the scorer only applies the filter
 *     when *both* users have times. Comparing them in SQL would risk changing
 *     results to save little.
 *   - **Days working.** A comma-separated string; the `days === 1` rule is a
 *     per-index superset test that SQL cannot express usefully.
 */

/**
 * Ceiling on rows the candidate query may read.
 *
 * This is a cost bound, **not** pagination. Prisma appends
 * `ORDER BY carpool_search.id ASC` to satisfy `take`, and id order is
 * unrelated to match quality — so if this limit is ever actually reached, the
 * rows dropped are arbitrary rather than the worst matches. It is set well
 * above the platform's current size so that it bounds pathological growth
 * without changing today's results. Raising the real ceiling means ranking in
 * SQL, which is a larger change than this ticket.
 */
export const CANDIDATE_LIMIT = 2000;

/** Distance filter values at or above this mean "any", so no bound applies. */
const DISTANCE_FILTER_MAX = 20;

/**
 * Latitude/longitude window that fully contains every point within `miles` of
 * the centre, under the same metric `calculateScore` uses.
 *
 * `milesBetween` is equirectangular with a cosine correction taken at the mean
 * of the two latitudes. For a point at distance `d <= miles`:
 *
 *   |dLat| * 69.09 <= d           so |dLat| <= miles / 69.09, exactly.
 *   |dLng| * 69.09 * cos(mean) <= d
 *
 * `cos(mean)` shrinks as |latitude| grows, and a smaller cosine admits a wider
 * longitude span — so the widest possible window uses the cosine at the far
 * edge of the latitude band, `|lat| + latDelta`. Using that keeps the box a
 * superset for every point inside it.
 *
 * Returns `null` for the longitude bound near the poles, where the cosine
 * collapses and the box would have to span the globe.
 */
export const boundingBox = (
  lat: number,
  lng: number,
  miles: number,
): {
  latMin: number;
  latMax: number;
  lngMin: number | null;
  lngMax: number | null;
} => {
  // A hair of slack so floating-point error cannot exclude a point sitting
  // exactly on the boundary that the scorer would have kept.
  const margin = 1.0001;
  const latDelta = (miles / MILES_PER_DEGREE_LATITUDE) * margin;

  const edgeLatitude = Math.min(Math.abs(lat) + latDelta, 90);
  const cosine = Math.cos((edgeLatitude * Math.PI) / 180);

  if (cosine < 1e-6) {
    return {
      latMin: lat - latDelta,
      latMax: lat + latDelta,
      lngMin: null,
      lngMax: null,
    };
  }

  const lngDelta = (miles / (MILES_PER_DEGREE_LATITUDE * cosine)) * margin;

  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lngMin: lng - lngDelta,
    lngMax: lng + lngDelta,
  };
};

/** Builds the coordinate filter for one location relation, if bounded. */
const locationWithin = (
  coords: { coordLat: number; coordLng: number } | null | undefined,
  miles: number,
): Prisma.LocationWhereInput | undefined => {
  // `>= 20` is the scorer's "any", and a missing centre means the scorer is
  // comparing against (0, 0) for everyone — in both cases SQL must not narrow.
  if (miles >= DISTANCE_FILTER_MAX || !coords) {
    return undefined;
  }

  const box = boundingBox(coords.coordLat, coords.coordLng, miles);

  return {
    coordLat: { gte: box.latMin, lte: box.latMax },
    ...(box.lngMin !== null && box.lngMax !== null
      ? { coordLng: { gte: box.lngMin, lte: box.lngMax } }
      : {}),
  };
};

/**
 * The roles this user could possibly carpool with.
 *
 * Mirrors the scorer's opening guard: a RIDER needs a DRIVER with a seat, a
 * DRIVER needs a RIDER, and a VIEWER is never a match for anyone. A VIEWER
 * browsing sees both real roles, which is what the scorer allows.
 */
const compatibleRoles = (role: Role): Role[] => {
  if (role === Role.RIDER) return [Role.DRIVER];
  if (role === Role.DRIVER) return [Role.RIDER];
  return [Role.DRIVER, Role.RIDER];
};

/**
 * The co-op date-overlap filter, mirroring the scorer branch for branch.
 *
 * `dateOverlap` 0 means any, so nothing is added. For 1 and 2 the scorer first
 * requires all four dates to exist, which is why the null checks come along:
 * without them SQL's three-valued logic would let a NULL-dated row through a
 * `NOT`, and the scorer would then drop it — a wasted read, though not a wrong
 * answer.
 */
const dateOverlapFilter = (
  filters: Pick<FInputs, "dateOverlap" | "startDate" | "endDate">,
): Prisma.CarpoolSearchWhereInput | undefined => {
  if (filters.dateOverlap === 0) {
    return undefined;
  }

  const notNull = {
    startDate: { not: null },
    endDate: { not: null },
  } as const;

  if (filters.dateOverlap === 2) {
    // fullOverlap: userStart <= currentStart && userEnd >= currentEnd
    return {
      startDate: { not: null, lte: filters.startDate },
      endDate: { not: null, gte: filters.endDate },
    };
  }

  // partialOverlap, negated exactly as the scorer writes it:
  // !((uStart < cStart && uEnd < cStart) || (uEnd > cEnd && uStart > cEnd))
  return {
    ...notNull,
    NOT: [
      {
        AND: [
          { startDate: { lt: filters.startDate } },
          { endDate: { lt: filters.startDate } },
        ],
      },
      {
        AND: [
          { endDate: { gt: filters.endDate } },
          { startDate: { gt: filters.endDate } },
        ],
      },
    ],
  };
};

/** The current user's own search, as much of it as the query needs. */
export type CurrentSearch = {
  role: Role;
  carpoolId: string | null;
  homeLocation: { coordLat: number; coordLng: number } | null;
  companyLocation: { coordLat: number; coordLng: number } | null;
};

/**
 * The `where` for the candidate query — previously `carpoolSearchQuery: any` in
 * both routers, so nothing about it type-checked (SCRUM-245).
 */
export const buildCandidateWhere = ({
  currentSearch,
  filters,
  excludedUserIds,
  favoriteUserIds,
}: {
  currentSearch: CurrentSearch;
  filters: FInputs & { favorites: boolean };
  excludedUserIds: string[];
  favoriteUserIds: string[];
}): Prisma.CarpoolSearchWhereInput => {
  const homeWithin = locationWithin(
    currentSearch.homeLocation,
    filters.startDistance,
  );
  const companyWithin = locationWithin(
    currentSearch.companyLocation,
    filters.endDistance,
  );

  const where: Prisma.CarpoolSearchWhereInput = {
    status: Status.ACTIVE,
    user: { isOnboarded: true },
    userId: {
      notIn: excludedUserIds,
      ...(filters.favorites ? { in: favoriteUserIds } : {}),
    },
    role: { in: compatibleRoles(currentSearch.role) },
  };

  // Only a RIDER cares about seats, and the scorer tests `=== 0` exactly, so
  // `not: 0` rather than `gt: 0` — a negative value would be kept by the
  // scorer and must not be dropped here.
  if (currentSearch.role === Role.RIDER) {
    where.seatsAvail = { not: 0 };
  }

  // Already carpooling together. `carpoolId` is nullable and SQL's `!=` drops
  // NULLs, so the ungrouped have to be re-admitted explicitly.
  if (currentSearch.carpoolId) {
    where.OR = [
      { carpoolId: null },
      { carpoolId: { not: currentSearch.carpoolId } },
    ];
  }

  if (homeWithin) {
    where.homeLocation = homeWithin;
  }
  if (companyWithin) {
    where.companyLocation = companyWithin;
  }

  const dates = dateOverlapFilter(filters);
  if (dates) {
    where.AND = [dates];
  }

  return where;
};

/**
 * Exactly the columns both endpoints need, and no more.
 *
 * `email` is deliberately absent (SCRUM-292). Both endpoints hand these rows to
 * `convertCarpoolSearchToPublic`, which does not disclose it, so selecting it
 * would only read a column to throw away - and leave the next person to wire it
 * back into a response.
 */
export const candidateInclude = {
  user: {
    select: {
      id: true,
      name: true,
      image: true,
      bio: true,
      preferredName: true,
      pronouns: true,
      isOnboarded: true,
    },
  },
  homeLocation: true,
  companyLocation: true,
} satisfies Prisma.CarpoolSearchInclude;

export type CandidateSearch = Prisma.CarpoolSearchGetPayload<{
  include: typeof candidateInclude;
}>;

/**
 * Scores candidates, orders them best-first and maps back to the full rows.
 *
 * The remap used to be `scores.map(s => candidates.find(c => c.user.id === s.id))`
 * in both routers — a linear scan per score, so O(n²) over the whole table. A
 * single index by user id makes it O(n) (SCRUM-245).
 */
export const rankCandidates = <T extends Parameters<typeof calculateScore>[0]>(
  candidates: T[],
  currentUserSearch: Parameters<typeof calculateScore>[0],
  filters: FInputs,
  sort: string,
): T[] => {
  const scores: Recommendation[] = _.compact(
    candidates.map(calculateScore(currentUserSearch, filters, sort)),
  );

  scores.sort((a, b) => a.score - b.score);

  const byUserId = new Map(
    candidates.map((candidate) => [candidate.user.id, candidate]),
  );

  return _.compact(scores.map((score) => byUserId.get(score.id)));
};

/**
 * Fetches a bounded candidate set and returns it ranked best-first.
 *
 * The single path both endpoints share; they differ only in how many of the
 * ranked rows they keep and which sort they ask for.
 */
export const fetchRankedCandidates = async ({
  prisma,
  currentUserSearch,
  filters,
  sort,
  excludedUserIds,
  favoriteUserIds,
}: {
  prisma: PrismaOrTransaction;
  currentUserSearch: Parameters<typeof calculateScore>[0] & CurrentSearch;
  filters: FInputs & { favorites: boolean };
  sort: string;
  excludedUserIds: string[];
  favoriteUserIds: string[];
}): Promise<CandidateSearch[]> => {
  const candidates = await prisma.carpoolSearch.findMany({
    where: buildCandidateWhere({
      currentSearch: currentUserSearch,
      filters,
      excludedUserIds,
      favoriteUserIds,
    }),
    include: candidateInclude,
    take: CANDIDATE_LIMIT,
  });

  return rankCandidates(candidates, currentUserSearch, filters, sort);
};
