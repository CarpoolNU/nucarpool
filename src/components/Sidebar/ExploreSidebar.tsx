import React, { useContext, useState } from "react";
import {
  EnhancedPublicUser,
  FiltersState,
  PublicUser,
  User,
} from "../../utils/types";
import { SidebarContent } from "./SidebarContent";
import Filters from "./Filters";
import { FaFilter } from "react-icons/fa6";
import CustomSelect from "./CustomSelect";
import { UserContext } from "../../utils/userContext";
import useIsMobile from "../../utils/useIsMobile";
import { QueryState } from "../../utils/queryState";

interface ExploreSidebarProps {
  recs: EnhancedPublicUser[];
  favs: EnhancedPublicUser[];
  /** Load state of each list, kept separate because the tab picks between them. */
  recsState: QueryState;
  favsState: QueryState;
  setFilters: React.Dispatch<React.SetStateAction<FiltersState>>;
  defaultFilters: FiltersState;
  setSort: React.Dispatch<React.SetStateAction<string>>;
  sort: string;
  filters: FiltersState;
  disabled: boolean;
  viewRoute: (user: User, otherUser: PublicUser) => void;
  onViewRequest: (userId: string) => void;
  mobileSelectedUser: string | null;
  handleMobileExpand: (userId?: string) => void;
}

const ExploreSidebar = (props: ExploreSidebarProps) => {
  const user = useContext(UserContext);
  const isMobile = useIsMobile();
  const [curOption, setCurOption] = useState<"recommendations" | "favorites">(
    "recommendations",
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  /**
   * Which filters differ from their defaults. Drives the "filters active"
   * indicator and which panel sections start open.
   *
   * `flexDays` and `daysWorking` were missing and are **gated on
   * the mode**, which is not a detail: `defaultFilters.daysWorking` is frozen
   * at `""` while `filters.daysWorking` is seeded from the signed-in user's own
   * days once `user.me` resolves. A bare `!==` would therefore report the day
   * filter as active on first load for every non-VIEWER, who has touched
   * nothing. Gated, they contribute only when a mode is selected — and with
   * `days === 0` neither value affects the results at all.
   */
  const getActiveFilters = () => {
    return {
      days: props.defaultFilters.days !== props.filters.days,
      flexDays:
        props.filters.days === 2 &&
        props.defaultFilters.flexDays !== props.filters.flexDays,
      daysWorking:
        props.filters.days !== 0 &&
        props.defaultFilters.daysWorking !== props.filters.daysWorking,
      dateOverlap:
        props.defaultFilters.dateOverlap !== props.filters.dateOverlap,
      startTime: props.defaultFilters.startTime !== props.filters.startTime,
      endTime: props.defaultFilters.endTime !== props.filters.endTime,
      startDistance:
        props.defaultFilters.startDistance !== props.filters.startDistance,
      endDistance:
        props.defaultFilters.endDistance !== props.filters.endDistance,
      favorites: props.defaultFilters.favorites !== props.filters.favorites,
      messaged: props.defaultFilters.messaged !== props.filters.messaged,
    };
  };
  const resetFilters = () => {
    if (!user) {
      return;
    }
    props.setFilters({
      ...props.defaultFilters,
      startDate: user.coopStartDate || props.filters.startDate,
      endDate: user.coopEndDate || props.filters.endDate,
      daysWorking: user.daysWorking,
    });
  };
  const activeFilters = getActiveFilters();
  const filtersActive = Object.values(activeFilters).some((value) => value);

  const sortOptions = [
    { value: "any", label: "Recommended" },
    { value: "distance", label: "Distance" },
    { value: "time", label: "Time" },
  ];

  /**
   * Whether the controls that act on the *list* belong on screen.
   *
   * False only in the mobile detail state, where `index.tsx` shrinks the sheet
   * and `SidebarContent` filters the list down to the one selected card: a
   * Recommendations/Favorites switch and a sort control have nothing to act on
   * there, and would crowd out the card they sit above.
   *
   * This carried an `isMobile` term until. Nothing cleared
   * `mobileSelectedUser` when the viewport crossed the breakpoint, so a card
   * expanded on a phone left it set at desktop width - and reading it alone
   * would have cost the desktop layout these controls over a state it can
   * neither produce nor escape. The page now derives the value through
   * `resolveMobileSelectedUser`, which is null whenever the viewport is not
   * mobile, so a non-null value here already implies mobile and the term was
   * doing nothing.
   */
  const showListControls = props.mobileSelectedUser === null;

  return (
    <div
      className="z-10 flex h-full flex-shrink-0 flex-col bg-white text-left"
      data-testid="explore-sidebar"
    >
      <div className={`flex-row px-5 ${isMobile ? "py-0" : "py-3"}`}>
        {/* Recommendations / Favorites.
         *
         * Rendered on both layouts. This was `!isMobile`, and it holds the only
         * `setCurOption("favorites")` call - so on mobile `curOption` was pinned
         * to `"recommendations"` for the component's lifetime and `props.favs`
         * could never be rendered. The favourite star on each card is not gated,
         * so favouriting was a write with no matching read: a mobile user could
         * save a match and had no way to see what they had saved.
         *
         * `isMobile` here now only picks a type scale. At `text-xl` the two
         * labels are wider than a 375px column minus this row's `px-5`, so the
         * mobile size is load-bearing rather than cosmetic. */}
        {showListControls && (
          <div className="flex justify-center gap-3">
            <button
              className={`rounded-xl p-2 font-semibold ${
                isMobile ? "text-base" : "text-xl"
              } ${
                curOption === "recommendations"
                  ? "bg-northeastern-red text-white"
                  : "text-black"
              }`}
              onClick={() => {
                setCurOption("recommendations");
              }}
            >
              Recommendations
            </button>
            <button
              className={`rounded-xl p-2 font-semibold ${
                isMobile ? "text-base" : "text-xl"
              } ${
                curOption === "favorites"
                  ? "bg-northeastern-red text-white"
                  : "text-black"
              }`}
              onClick={() => {
                setCurOption("favorites");
                setFiltersOpen(false);
              }}
            >
              Favorites
            </button>
          </div>
        )}

        {/* Sort and the filter button, likewise no longer `!isMobile`. This
         * block holds the only `setFiltersOpen(true)` call site, which is what
         * made all 617 lines of `Filters` unreachable on mobile rather than
         * merely cramped - the panel itself sets no width and flows into a
         * narrow column unchanged.
         *
         * The three remaining conditions are deliberate and unrelated to
         * viewport: `!filtersOpen` swaps this row out for the panel,
         * `!props.disabled` hides it from a VIEWER who cannot act on results,
         * and `curOption === "recommendations"` reflects that neither sort nor
         * filters apply to the favourites list. */}
        {showListControls &&
          !filtersOpen &&
          !props.disabled &&
          curOption === "recommendations" && (
            <div
              className={`relative flex items-center justify-between ${
                isMobile ? "mt-2" : "mx-4 mt-6"
              }`}
            >
              <CustomSelect
                value={props.sort}
                onChange={props.setSort}
                options={sortOptions}
                title={"Sort by"}
                className="!w-1/2"
              />
              <button
                type="button"
                className={`rounded-full p-3 ${
                  filtersActive
                    ? "bg-northeastern-red text-white"
                    : "bg-stone-100 text-black"
                }`}
                onClick={() => setFiltersOpen(true)}
                aria-label="Open filters"
              >
                <FaFilter className="text-xl" aria-hidden="true" />
              </button>
            </div>
          )}
      </div>

      <div className="relative h-full w-full">
        {filtersOpen ? (
          <Filters
            setFilters={props.setFilters}
            activeFilters={activeFilters}
            filters={props.filters}
            onClose={() => setFiltersOpen(false)}
            resetFilters={() => resetFilters()}
          />
        ) : (
          <SidebarContent
            userCardList={
              curOption == "recommendations" ? props.recs : props.favs
            }
            subType={curOption}
            loadState={
              curOption == "recommendations" ? props.recsState : props.favsState
            }
            disabled={props.disabled}
            onViewRouteClick={props.viewRoute}
            onCardClick={() => {}}
            selectedUser={null}
            onViewRequest={props.onViewRequest}
            mobileSelectedUser={props.mobileSelectedUser}
            handleMobileExpand={props.handleMobileExpand}
          />
        )}
      </div>
    </div>
  );
};

export default ExploreSidebar;
