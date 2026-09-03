import { Prisma, Role, Status } from "@prisma/client";
import _ from "lodash";
import {
  MILES_PER_DEGREE_LATITUDE,
  calculateScore,
} from "../../utils/recommendation";
import type { FInputs, Recommendation } from "../../utils/recommendation";
import type { PrismaOrTransaction } from "./client";
import { SEAT_AVAILABLE_FILTER } from "../../utils/carpoolSeats";

/**
 * The candidate query behind both matching endpoints.
 *
 * `mapbox.geoJsonUserList` and `user.recommendations.me` used to hold two
 * near-identical copies of this: fetch *every* ACTIVE carpool search with its
 * user and both location rows, score the whole table in JavaScript, sort, then
 * slice to 150 or 50. Nothing beyond `status` and an exclusion list reached
 * SQL, there was no `take`, and both endpoints run on the same explore page
 * load with the same filters — so every filter interaction read the entire
 * table twice. On PlanetScale, where billing is per row read, that is a direct
 * cost.
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
 *     storage ambiguity, and the scorer only applies the filter
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
 *
 * Reaching it is no longer silent — see `candidateLimitWarning`.
 */
export const CANDIDATE_LIMIT = 2000;

/** Prefix for the ceiling warning, matching `cspReport`'s logging convention. */
export const CANDIDATE_LIMIT_LOG_PREFIX = "[candidate-limit]";

/**
 * The warning to emit when the candidate query came back truncated, or `null`
 * when it did not.
 *
 * The ceiling above is a cost bound that does not degrade gracefully: `take`
 * makes Prisma append `ORDER BY carpool_search.id ASC`, and cuid order has
 * nothing to do with match quality, so the rows dropped at the boundary are
 * arbitrary rather than the worst. Nothing reported that, which is the actual
 * hazard — the first symptom would be users quietly not seeing matches that
 * exist, which is indistinguishable from there being no good matches. This
 * turns that into a log line.
 *
 * **How full is it really?** Measured against the production-derived `staging`
 * branch, in the widest case (distance filters "any", so no bounding box, and
 * no date filter), the query reads:
 *
 *   - 48 rows for a RIDER — only drivers, and only with a seat
 *   - 685 rows for a DRIVER
 *   - 751 rows for a VIEWER, who is offered both roles
 *
 * So the worst case is about **38% of the ceiling**, and reaching it needs the
 * matchable population to grow by roughly 165%. An earlier estimate of 64% on
 * SCRUM-345 counted every ACTIVE `carpool_search` row; the query also requires
 * `user.isOnboarded` and a compatible role, and 521 of staging's rows are
 * un-onboarded signups sitting at the `(0, 0)` sentinel.
 *
 * That headroom is why ranking in SQL is deliberately **not** done here: it
 * would have to reproduce `calculateScore`'s ordering closely enough to keep
 * the scoring tests meaningful, and nothing today needs it. This warning is
 * what makes deferring it safe rather than a bet — the ceiling can no longer
 * be reached quietly while everyone assumes there is room.
 */
export const candidateLimitWarning = ({
  rowsFetched,
  role,
  sort,
}: {
  rowsFetched: number;
  role: Role;
  sort: string;
}): string | null =>
  rowsFetched > CANDIDATE_LIMIT
    ? `${CANDIDATE_LIMIT_LOG_PREFIX} candidate query hit its ${CANDIDATE_LIMIT}-row ceiling for a ${role} sorting by "${sort}". Rows past the ceiling are dropped in id order, not by score, so this ranking is missing candidates that may outrank the ones kept.`
    : null;

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
 * both routers, so nothing about it type-checked.
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

  // Only a RIDER cares about seats. `SEAT_AVAILABLE_FILTER` is the same
  // predicate `reserveSeat` decrements under and `calculateScore` scores by,
  // so the superset rule below holds by identity rather than by argument.
  //
  // This was `not: 0`, to match a scorer that tested `=== 0` — the pair agreed
  // with each other and both admitted a negative count, so the one ACTIVE
  // driver at -1 was offered to riders and then refused every one of them.
  // See SCRUM-348 and `hasSeatAvailable`.
  if (currentSearch.role === Role.RIDER) {
    where.seatsAvail = SEAT_AVAILABLE_FILTER;
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
 * `email` is deliberately absent. Both endpoints hand these rows to
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
 * single index by user id makes it O(n).
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
  // One row past the ceiling, so truncation is *detected* rather than guessed
  // at. Asking for exactly `CANDIDATE_LIMIT` cannot distinguish "the ceiling
  // cut the set short" from "exactly that many rows matched", and the second
  // case would report a loss that never happened. The extra row is discarded
  // below, so the ranked output is identical either way; the cost is one row
  // read, and only when the set is genuinely that large.
  const fetched = await prisma.carpoolSearch.findMany({
    where: buildCandidateWhere({
      currentSearch: currentUserSearch,
      filters,
      excludedUserIds,
      favoriteUserIds,
    }),
    include: candidateInclude,
    take: CANDIDATE_LIMIT + 1,
  });

  const warning = candidateLimitWarning({
    rowsFetched: fetched.length,
    role: currentUserSearch.role,
    sort,
  });
  if (warning) {
    console.warn(warning);
  }

  // Sliced only when it has to be, so the ordinary path does not copy the array.
  const candidates =
    fetched.length > CANDIDATE_LIMIT
      ? fetched.slice(0, CANDIDATE_LIMIT)
      : fetched;

  return rankCandidates(candidates, currentUserSearch, filters, sort);
};
