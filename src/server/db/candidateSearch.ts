import { Prisma, Role, Status } from "@prisma/client";
import _ from "lodash";
import {
  MILES_PER_DEGREE_LATITUDE,
  calculateScore,
} from "../../utils/recommendation";
import type { FInputs, Recommendation } from "../../utils/recommendation";
import type { PrismaOrTransaction } from "./client";
import { SEAT_AVAILABLE_FILTER } from "../../utils/carpoolSeats";
import { DISTANCE_FILTER_ANY } from "../../utils/filters/filterSentinels";
import {
  UNGROUPED_CANDIDATE_FILTER,
  searcherCanMatchNobody,
} from "../../utils/candidateReachability";
import { blockedCounterpartIds } from "./blocks";
import type { BlockReader } from "./blocks";

/**
 * The candidate query behind both matching endpoints.
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
 * rows dropped are arbitrary rather than the worst matches. Raising the real
 * ceiling means ranking in SQL, which is a larger change than the one that
 * introduced this.
 *
 * It was set "well above the platform's current size". **That is no longer the
 * right description**: production's worst case was 73% of it on 2026-10-08,
 * against the 38% recorded when this was written — a gap that turned out to be
 * staging quoted as production rather than growth. `candidateLimitWarning`
 * below carries the current figures, what the remaining headroom is made of,
 * and the threshold at which ranking in SQL becomes the active ticket.
 *
 * **Changing this number is not the response to approaching it**, in either
 * direction, and SCRUM-643 deliberately left it alone.
 *
 * Reaching it emits a warning — see `candidateLimitWarning`.
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
 * **How full is it really? Re-measured 2026-10-08 under SCRUM-643**, read-only
 * against the PlanetScale `main` branch, in the widest case (distance filters
 * "any", so no bounding box, and no date filter):
 *
 *   - **66** rows for a RIDER — only drivers, and only with a seat
 *   - **1,317** rows for a DRIVER — only ungrouped riders
 *   - **1,463** rows for a VIEWER, who is offered both roles and narrowed by
 *     neither the seat rule nor the group rule, and is therefore the worst case
 *
 * So the worst case is **73% of the ceiling**, and reaching it needs the
 * matchable population to grow by **37%**.
 *
 * **The figures this replaced said 38% and 165%, and were not wrong when they
 * were taken — they were `staging`'s.** Re-running the same predicate against
 * staging on the same day still returns 751 for a VIEWER, so the number had
 * not drifted; staging simply holds 764 matchable rows against production's
 * 2,550. Reading one as the other is the trap, and it understated production's
 * position by half. (The old DRIVER figure of 685 was also staging's `RIDER`
 * count before `UNGROUPED_CANDIDATE_FILTER`; the comparable value is 667.)
 *
 * *Matchable* throughout means `status: ACTIVE` **and** `user.isOnboarded` —
 * the floor every branch of this query shares, before role, seats or group.
 * It is well below the raw `ACTIVE` count, which on production is 3,001: an
 * un-onboarded signup sits at the `(0, 0)` sentinel and was never in matching.
 * An estimate taken against `ACTIVE` alone overstates the pool, which is how
 * an even earlier figure of 64% arose.
 * Re-derive all of this with `scripts/measure-candidate-rows.ts`, which now
 * reports headroom per role — **name the environment whenever you quote it.**
 *
 * **What the remaining 27% is made of matters more than its size.** 1,123 of
 * those 1,463 rows — 77% — are searches whose `end_date` has already passed.
 * Only 296 are co-ops still running. So the ceiling is being approached by
 * rows that should not be in the candidate set on any reading, not by the
 * platform outgrowing the bound, and SCRUM-631's liveness rule would take the
 * worst case to roughly 340 rows, about 17% of the ceiling.
 *
 * **The threshold, so this is a decision and not a vibe (SCRUM-643 AC 3).**
 * Ranking in SQL becomes the active ticket when the worst case exceeds **80%
 * of `CANDIDATE_LIMIT`** — that is 1,600 rows, 137 above where production sat
 * on 2026-10-08. Raise it with SCRUM-631 instead if that is still open, since
 * it is the cheaper move and buys back four times as much. Below 80%, ranking
 * in SQL stays deliberately undone: it would have to reproduce
 * `calculateScore`'s ordering closely enough to keep the scoring tests
 * meaningful, and nothing today needs it.
 *
 * **Do not raise `CANDIDATE_LIMIT` as the response to crossing that line.** The
 * bound exists because reading the whole table is what this change removed, and
 * a higher number keeps the arbitrary-drop defect while making it cost more.
 *
 * ---
 *
 * **Where this warning actually goes, which SCRUM-643 AC 1 asked and the
 * answer is "nowhere confirmed".** `console.warn` reaches the Amplify SSR
 * runtime's output and no further that anyone in this repository can
 * demonstrate. That is not specific to this line — it is the same unanswered
 * question recorded in `router/errorLog.ts` ("nobody has yet confirmed where
 * the deployed server's output is read") and acted on in
 * `profile/coopRangeNotice.ts`, which chose to tell the affected user rather
 * than "a log nobody has located". Settling it needs Amplify console access,
 * which no credential in this repository carries, so it cannot be closed here.
 *
 * **So the bound is not left resting on that line.** A log line only fires
 * *after* the ceiling is breached, by which point users have already silently
 * lost matches. `scripts/measure-candidate-rows.ts` answers the same question
 * *before* the breach and against whichever environment you point it at, which
 * is strictly the stronger signal and needs no log destination to exist. Treat
 * the warning as the backstop and a dated run of that script as the control;
 * record each run per "Has a script been applied to staging or production?" in
 * `scripts/README.md`. A third-party error reporter is deliberately still not
 * adopted — `errorLog.ts` records both reasons, and neither has changed.
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
  // `>= DISTANCE_FILTER_ANY` is the scorer's "any", and a missing centre means
  // the scorer is comparing against (0, 0) for everyone — in both cases SQL
  // must not narrow.
  if (miles >= DISTANCE_FILTER_ANY || !coords) {
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
  seatsAvail: number;
  homeLocation: { coordLat: number; coordLng: number } | null;
  companyLocation: { coordLat: number; coordLng: number } | null;
};

/** The `where` for the candidate query. */
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
  // `not: 0` would admit a negative seat count exactly as a scorer test of
  // `=== 0` does, so an ACTIVE driver sitting at -1 would be offered to every
  // rider and then refused by each one. See `hasSeatAvailable`.
  if (currentSearch.role === Role.RIDER) {
    where.seatsAvail = SEAT_AVAILABLE_FILTER;
  }

  // The group rules the accept paths in `groups.ts` impose. Both are shared
  // with `calculateScore` rather than restated here — `candidateReachability.ts`
  // is where each one is justified, and `candidateSearch.test.ts`'s
  // "group exclusion agrees with calculateScore" fails if either caller drifts.
  //
  // `searcherCanMatchNobody` answers for the viewer's own row, before any
  // candidate is looked at, so an empty `id` filter empties the result rather
  // than adding a predicate that would have to be threaded through every
  // branch below. `UNGROUPED_CANDIDATE_FILTER` is the only rule that narrows
  // the *candidate*, and only a DRIVER viewer needs it: a grouped DRIVER with
  // a seat left is still valid for an ungrouped RIDER, so this is not the
  // mirror of the grouped-rider rule.
  if (searcherCanMatchNobody(currentSearch)) {
    where.id = { in: [] };
  } else if (currentSearch.role === Role.DRIVER) {
    Object.assign(where, UNGROUPED_CANDIDATE_FILTER);
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
 * The index by user id keeps this O(n); a linear scan per score instead would
 * be O(n²) over the whole candidate table.
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
 * The users the candidate query must never return to `userId`.
 *
 * Centralized rather than inlined per caller: a third exclusion concern added
 * to two separate copies is how one of them ends up missing it.
 *
 *   - **The reader.** Always.
 *   - **Anyone with a block against the reader, in either direction.** Always,
 *     whatever the filters say. Blocking is not a filter the user toggles.
 *   - **Anyone the reader has a request with.** Only when the "messaged"
 *     filter is off, which is the filter's whole meaning.
 *
 * The requests are passed in rather than read here, because both callers
 * already load them through the reader's own search in the same query.
 */
export const candidateExclusions = async ({
  prisma,
  userId,
  messaged,
  sentRequests,
  receivedRequests,
}: {
  prisma: BlockReader;
  userId: string;
  messaged: boolean;
  sentRequests: { toUserId: string }[] | undefined;
  receivedRequests: { fromUserId: string }[] | undefined;
}): Promise<string[]> => {
  const excluded = [userId, ...(await blockedCounterpartIds(prisma, userId))];

  // `?? []` because both callers include the requests only when `messaged`
  // is false, and Prisma omits the key entirely for a false include.
  if (!messaged) {
    excluded.push(
      ...(sentRequests ?? []).map((r) => r.toUserId),
      ...(receivedRequests ?? []).map((r) => r.fromUserId),
    );
  }

  return excluded;
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
