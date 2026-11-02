import { Role } from "@prisma/client";
import type { FInputs } from "../../utils/recommendation";
import { TIME_FILTER_ANY } from "../../utils/filters/filterSentinels";
import { riderDemandToDisplay } from "../../utils/riderDemand/floor";
import { candidateExclusions, fetchRankedCandidates } from "./candidateSearch";
import type { CurrentSearch } from "./candidateSearch";
import type { PrismaOrTransaction } from "./client";

/**
 * The matching query run backwards: "how many riders could you carry?"
 *
 * `buildCandidateWhere` takes a searcher and returns the counterparts
 * compatible with them. It has only ever been called one way — *show me my
 * candidates* — but the predicate is symmetric, and asking it on behalf of a
 * driver the reader is not yet answers the one question the product has never
 * put to a potential driver.
 *
 * ## Reuse is the design, not an optimisation
 *
 * This module adds **no matching rules**. It builds a hypothetical search,
 * hands it to `fetchRankedCandidates` — the same function both real matching
 * endpoints call — and counts what comes back. Everything the count has to
 * respect it inherits by construction:
 *
 *   - **Blocks**, in both directions, from `candidateExclusions`.
 *   - **Group membership**, from `UNGROUPED_CANDIDATE_FILTER`, which
 *     `buildCandidateWhere` applies to a DRIVER searcher's candidates.
 *   - **Liveness**, from `coopIsLiveFilter`, which is unconditional. This is
 *     the predicate SCRUM-631 and SCRUM-633 built and the reason this ticket
 *     was sequenced behind them: counted without it, the number would quote
 *     the 1,131 ended co-ops and 44 dateless rows those tickets removed, and
 *     advertise demand that does not exist.
 *   - **Onboarding and ACTIVE status**, the floor every branch of that query
 *     shares.
 *
 * A second copy of any of those would drift, and the failure would be silent
 * and the wrong way round: the count would keep promising riders who are not
 * there, and the driver who switched role to reach them would find an empty
 * list. Reusing the path makes that impossible rather than unlikely.
 *
 * ## Why the ranked path and not `prisma.carpoolSearch.count`
 *
 * A `count` on `buildCandidateWhere`'s `where` is one query instead of a read
 * plus a scoring pass, and it is the wrong number. That `where` is
 * deliberately a **superset** of what the scorer keeps — the header comment on
 * `candidateSearch.ts` states the rule — so counting its rows counts the
 * bounding *box* rather than the radius, and leaves the time and day filters
 * unapplied entirely. It would overstate demand, which is exactly the failure
 * mode this feature cannot afford.
 *
 * Running the full path instead makes the count **identical by construction**
 * to the list that reader would see on the Explore page one second after
 * switching their role to Driver. That is a far stronger property than a
 * cheaper number, and it costs a scoring pass over a few hundred rows: the
 * widest DRIVER query on production read 287 (see `candidateLimitWarning`),
 * and the radius below narrows it well under that.
 */

/**
 * The corridor the count describes, in miles, at both ends of the route.
 *
 * **The platform's own default filter is "any distance"** —
 * `pages/index.tsx` seeds both sliders at `DISTANCE_FILTER_ANY` — and that
 * default is wrong for this number. Counted at "any", it would return every
 * live rider on the platform, which is a platform statistic rather than a
 * reason for *this* reader to drive: "287 riders are looking" says nothing
 * about whether any of them is on their way to work.
 *
 * So the radius is fixed here rather than taken from the caller, for two
 * reasons beyond that one. The explore filters are a control the reader
 * fiddles with, and a headline number that swung as they moved a slider would
 * read as noise. And the procedure takes **no input at all**, so there is no
 * parameter a client could widen to turn a floored count into a population
 * probe — the floor cannot be walked around by asking the same question at
 * eleven radii.
 *
 * Ten miles, which is half the slider's expressible range, is a corridor
 * someone would plausibly detour across for a passenger; `DISTANCE_FILTER_ANY`
 * is its ceiling and 0 would admit only an exact coordinate match. Both ends
 * are bounded: a rider who lives nearby but commutes to another city is not
 * someone this reader could carry.
 */
export const RIDER_DEMAND_RADIUS_MILES = 10;

/**
 * The seat count the hypothetical driver is given.
 *
 * **Not cosmetic, and not zero.** `searcherCanMatchNobody` answers `true` for
 * a DRIVER with no seat — `reserveSeat` would refuse every rider — and
 * `buildCandidateWhere` turns that into `id: { in: [] }`. A rider's own row
 * carries `seatsAvail: 0` by default, so inheriting it would empty the result
 * for every single reader and the feature would silently never fire.
 *
 * One seat is also the honest reading of the question. "How many riders could
 * you carry" assumes the smallest car that is still a carpool, and a reader
 * who switches and declares four seats can only find the number got larger,
 * never smaller.
 */
const HYPOTHETICAL_SEATS = 1;

/**
 * The reader's own search, seen as the driver they are not.
 *
 * Only `role` and `seatsAvail` move. The route, the group state and the
 * schedule are the reader's real ones, because the question is about *their*
 * commute — a hypothetical that also moved the geography would be answering
 * somebody else's.
 */
export const asHypotheticalDriver = <T extends CurrentSearch>(
  search: T,
): T => ({
  ...search,
  role: Role.DRIVER,
  seatsAvail: HYPOTHETICAL_SEATS,
});

/**
 * The filter set the count is taken under.
 *
 * Fixed rather than supplied, per `RIDER_DEMAND_RADIUS_MILES`. Each sentinel
 * is the "off" value for its filter, so the only things narrowing the result
 * are the radius and the predicates `buildCandidateWhere` applies
 * unconditionally:
 *
 *   - **`dateOverlap: 0`** — "any". The searcher's date *preference* is an
 *     explore control they have not expressed here, and `coopIsLiveFilter`
 *     already removes every search that is not currently running. Setting 1
 *     or 2 would additionally drop a rider whose co-op merely starts in a
 *     different month, which is demand this reader could serve.
 *   - **`days: 0`** — the day filter does not apply. `daysWorking: ""` means
 *     the same thing twice over (see `dayMatchApplies`); both are set so
 *     neither alone is load-bearing.
 *   - **`startTime`/`endTime` at `TIME_FILTER_ANY`** — the scorer applies the
 *     time cutoff only when both parties have times, and a count that
 *     silently excluded riders over a schedule the reader never set would be
 *     understating demand for an unstated reason.
 *
 * `startDate`/`endDate` are unused while `dateOverlap` is 0 — the scorer
 * reads them only inside that branch — and are filled from the reader's own
 * co-op window so that the shape is honest if the overlap rule ever changes.
 * `new Date()` is the fallback for a search holding no dates, which after
 * SCRUM-633 cannot be in the candidate pool anyway.
 */
export const riderDemandFilters = (search: {
  startDate: Date | null;
  endDate: Date | null;
}): FInputs & { favorites: boolean } => ({
  startDistance: RIDER_DEMAND_RADIUS_MILES,
  endDistance: RIDER_DEMAND_RADIUS_MILES,
  startTime: TIME_FILTER_ANY,
  endTime: TIME_FILTER_ANY,
  days: 0,
  flexDays: 1,
  daysWorking: "",
  startDate: search.startDate ?? new Date(),
  endDate: search.endDate ?? new Date(),
  dateOverlap: 0,
  favorites: false,
});

/** The reader's own search, as much of it as this query needs. */
export type DemandReaderSearch = Parameters<
  typeof fetchRankedCandidates
>[0]["currentUserSearch"] & {
  startDate: Date | null;
  endDate: Date | null;
};

/**
 * Whether this reader should be asked the question at all.
 *
 * Three states say no, and each is a different kind of no:
 *
 *   - **A DRIVER.** They have already answered it. The number would be their
 *     own recommendations list restated, which they are looking at.
 *   - **A reader already in a carpool group.** `UserSection` locks the role
 *     control for them — a group has exactly one driver and it is already set
 *     — so the notice would urge an action the form refuses. Nagging someone
 *     about a button that is disabled is worse than silence.
 *   - **No search at all.** Nothing to build a hypothetical from.
 *
 * A RIDER and a VIEWER both pass, which is the ticket's acceptance criterion
 * read literally. A VIEWER is included deliberately even though it is the
 * role with the cross-reference hazard — `floor.ts` carries that argument,
 * and the floor is the control for it rather than exclusion.
 */
export const readerSeesRiderDemand = (
  search: { role: Role; carpoolId: string | null } | null | undefined,
): boolean =>
  !!search && search.role !== Role.DRIVER && search.carpoolId === null;

/**
 * How many riders this reader could carry, floored, or `null`.
 *
 * `null` covers every case in which the reader is told nothing: they are a
 * driver already, they are in a group, or the count fell below
 * `RIDER_DEMAND_FLOOR`. The caller cannot tell those apart from the return
 * value, and nor can anyone reading the response — which is the point, since
 * distinguishing "suppressed" from "zero" would narrow the range the floor
 * exists to hide.
 */
export const riderDemandCount = async ({
  prisma,
  userId,
  search,
  now,
}: {
  prisma: PrismaOrTransaction;
  userId: string;
  search: DemandReaderSearch;
  /** Injectable clock for the liveness boundary; see `coopLiveness.ts`. */
  now?: Date;
}): Promise<number | null> => {
  if (!readerSeesRiderDemand(search)) {
    return null;
  }

  // `messaged: true` — "do not hide people I have a request with". A rider
  // this reader has already messaged still wants a ride, and the messaged
  // filter is an explore-list convenience rather than a rule about who exists.
  // Blocks are excluded either way: `candidateExclusions` applies those
  // whatever the filter says, which is what carries that acceptance criterion.
  const excludedUserIds = await candidateExclusions({
    prisma,
    userId,
    messaged: true,
    sentRequests: undefined,
    receivedRequests: undefined,
  });

  const candidates = await fetchRankedCandidates({
    prisma,
    currentUserSearch: asHypotheticalDriver(search),
    filters: riderDemandFilters(search),
    sort: "any",
    excludedUserIds,
    favoriteUserIds: [],
    now,
  });

  return riderDemandToDisplay(candidates.length);
};
