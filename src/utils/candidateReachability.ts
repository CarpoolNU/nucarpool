import { Role } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { hasSeatAvailable } from "./carpoolSeats";

/**
 * Which candidates an accept path could ever link to, expressed once.
 *
 * Discovery evaluates these rules twice over: `buildCandidateWhere` narrows in
 * SQL and `calculateScore` decides in JavaScript, and the SQL half must stay a
 * superset of the JS half or the map silently loses matches. Three
 * "unreachable candidate" rules were once added to both halves and tied
 * together only by matching comments, which is the arrangement
 * `hasSeatAvailable` and
 * `SEAT_AVAILABLE_FILTER` exist to avoid: one definition, plus a test that
 * fails if either caller is changed alone.
 *
 * This module is that definition for the group rules. The reason they exist at
 * all is a single invariant in `groups.ts` — both accept paths (`create` and
 * `add`) require the *rider's* own row to hold `carpoolId: null` before they
 * link it — and every rule below is a consequence of it rather than an
 * independent policy.
 *
 * Kept out of `carpoolSeats.ts` because a group is not a seat, and out of
 * `roleCompatibility.ts` because that module answers whether two *roles* fit
 * and owns the copy explaining it to a reader. This answers whether a *row* is
 * linkable, and has no user-facing text.
 */

/**
 * The part of a carpool search that decides whether it can be matched at all.
 *
 * Structural rather than a `Pick` of `CarpoolSearch`, because both callers hold
 * a different shape: `buildCandidateWhere` has `CurrentSearch`, the scorer has
 * a joined `CarpoolSearch`. Both carry these three columns under these names —
 * note `seatsAvail`, the storage spelling, not the flattened `seatAvail` the
 * API returns.
 */
export type SearcherReachability = {
  role: Role;
  carpoolId: string | null;
  seatsAvail: number;
};

/**
 * "No candidate on the platform could accept this searcher, whoever they are."
 *
 * Two states make the whole result set unreachable, so both callers can answer
 * before looking at a single candidate:
 *
 *   - **A grouped RIDER.** Every accept path needs their row's `carpoolId` to
 *     be null before it links them, so they can join no group — not another
 *     driver's, and not the one already holding them. The rule this replaced
 *     compared the two groups, which excluded only the driver in the rider's
 *     own group and still offered drivers from every other one, all of which
 *     `connectAction` refuses with CONFLICT.
 *   - **A DRIVER with no seats.** `reserveSeat` refuses every rider for as
 *     long as they stay full, so offering them anybody produces a request that
 *     cannot be accepted. Non-positive is unavailable — see `hasSeatAvailable`.
 *
 * A grouped DRIVER is deliberately **not** the mirror of the first rule: with a
 * seat left they are still a valid candidate for an ungrouped rider, which is
 * what `candidateIsUngrouped` narrows instead.
 *
 * `carpoolId` is read for truthiness rather than against `null`, so a row
 * selected without the column behaves as ungrouped rather than as grouped —
 * the direction that reads too many candidates instead of hiding reachable
 * ones.
 */
export const searcherCanMatchNobody = (search: SearcherReachability): boolean =>
  (search.role === Role.RIDER && !!search.carpoolId) ||
  (search.role === Role.DRIVER && !hasSeatAvailable(search.seatsAvail));

/**
 * "This candidate's own row could still be linked into a group."
 *
 * The candidate-side half of the same `groups.ts` invariant, and the one a
 * DRIVER searcher needs: a rider already holding a `carpoolId` can never be
 * accepted, whichever group holds them.
 *
 * Only meaningful for a RIDER candidate — a DRIVER candidate's group state says
 * nothing about whether they can take another rider, and both callers have
 * already excluded an incompatible role by the time they ask.
 */
export const candidateIsUngrouped = (candidate: {
  carpoolId?: string | null;
}): boolean => !candidate.carpoolId;

/**
 * `candidateIsUngrouped` as a Prisma filter, for the predicate the database has
 * to evaluate rather than JavaScript.
 *
 * Prisma reads a literal `null` on a nullable column as `IS NULL`, so this is
 * the same rule in the only shape SQL can express it. Shared rather than
 * written out at the call site for the reason `SEAT_AVAILABLE_FILTER` is:
 * `candidateSearch.test.ts` drives both callers over the same table of
 * candidate states and asserts their verdicts match, which fails if either one
 * is changed alone.
 */
export const UNGROUPED_CANDIDATE_FILTER = {
  carpoolId: null,
} satisfies Prisma.CarpoolSearchWhereInput;
