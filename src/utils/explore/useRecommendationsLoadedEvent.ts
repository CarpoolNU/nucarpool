import { useEffect, useRef } from "react";
import { roleFetchesRecommendations } from "../../components/Sidebar/viewerAccess";
import { trackRecommendationsLoaded } from "../mixpanel";
import { User } from "../types";

/**
 * The slice of `trpc.user.recommendations.me.useQuery()` this reads. Declared
 * structurally so a plain object satisfies it in a test, the way
 * `QueryLike` in `utils/queryState.ts` is.
 *
 * `data` rather than a count passed alongside, so the number and the
 * `dataUpdatedAt` it is attributed to necessarily come from the same snapshot.
 */
export type RecommendationsQueryLike = {
  isSuccess: boolean;
  /** When the query last resolved. React Query's own clock; 0 before it has. */
  dataUpdatedAt: number;
  data: readonly unknown[] | undefined;
};

/** What the event needs from the signed-in user's own search. */
export type RecommendationsLoadProfile = Pick<
  User,
  "role" | "companyCity" | "companyState"
>;

/**
 * Records how many candidates a rider's or driver's search returned
 * (SCRUM-570).
 *
 * The driver shortage — 266 live riders to 22 live drivers, 54 seats between
 * them — is invisible in every dashboard the team has. It can be established
 * only by hand-writing SQL against production, and a point-in-time
 * reconstruction cannot be trended, so a week in which it worsens passes
 * unnoticed. This is the event that makes "how many riders saw nobody this
 * week, and where were they commuting?" a question Mixpanel can answer.
 *
 * ## Why this lives beside the query and not in `SidebarContent`
 *
 * `SidebarContent` renders the list and the empty state, which makes it the
 * obvious site and the wrong one. It is **unmounted and remounted by ordinary
 * UI fiddling**: `ExploreSidebar` swaps it out wholesale for the `Filters`
 * panel (`filtersOpen ? <Filters/> : <SidebarContent/>`), and toggling
 * Recommendations → Favorites → Recommendations swings its `subType` away and
 * back. Either would re-emit, so the count of riders who saw an empty list
 * would really be a count of how often people opened the filter panel. For a
 * number whose entire purpose is to be compared week to week, that is fatal.
 *
 * The query is the thing that loads, so the page that owns the query owns the
 * event. Nothing about the render path is lost: the list `SidebarContent`
 * draws *is* this query's data.
 *
 * ## What "once per load" means here
 *
 * Once per distinct `dataUpdatedAt` — that is, once per resolved fetch — for
 * as long as this hook stays mounted. That is what makes it survive a
 * re-render, and StrictMode's double-invoked effects along with it: the ref is
 * per component instance, not per effect invocation.
 *
 * Two consequences worth stating rather than discovering:
 *
 * - **A changed filter or sort re-emits**, because it is a genuinely new
 *   search with a genuinely new count. That is wanted.
 * - **A return navigation to `/` emits twice**: the call site sets
 *   `refetchOnMount: true`, so the remount serves the cached list (one event)
 *   and then the refetched list (another). Both are lists the user was shown.
 *   Suppressing the first would mean tying this hook to the call site's
 *   caching options, and a rule that can silently stop emitting is the worse
 *   failure for a supply signal than one that occasionally emits twice —
 *   count unique users, not raw events, when trending this.
 *
 * ## Who is counted
 *
 * Not a VIEWER. Their empty recommendations list is a role explanation, not an
 * unserved rider, and folding the two together would overstate unmet demand by
 * the ~13 live viewers. The gate is `roleFetchesRecommendations`, the same
 * predicate that decides whether the query runs at all (SCRUM-460) — so the
 * event cannot drift from the request behind it. It is belt and braces today,
 * since a gated query never reaches `isSuccess`; it is what keeps this correct
 * if that gate is ever relaxed.
 */
export const useRecommendationsLoadedEvent = (
  query: RecommendationsQueryLike,
  user: RecommendationsLoadProfile | null | undefined,
): void => {
  /** The `dataUpdatedAt` already reported, so a re-render cannot repeat it. */
  const reportedAt = useRef<number | null>(null);

  const { isSuccess, dataUpdatedAt } = query;
  const resultCount = query.data?.length ?? 0;
  const role = user?.role;
  const companyCity = user?.companyCity;
  const companyState = user?.companyState;

  useEffect(() => {
    // `role === undefined` is the first render, before `user.me` resolves.
    // `roleFetchesRecommendations` already answers `false` for it; the
    // explicit test is what narrows the type for the call below.
    if (role === undefined || !roleFetchesRecommendations(role)) {
      return;
    }
    if (!isSuccess || reportedAt.current === dataUpdatedAt) {
      return;
    }
    reportedAt.current = dataUpdatedAt;

    trackRecommendationsLoaded({
      resultCount,
      role,
      companyCity: companyCity ?? "",
      companyState: companyState ?? "",
    });
  }, [isSuccess, dataUpdatedAt, resultCount, role, companyCity, companyState]);
};
