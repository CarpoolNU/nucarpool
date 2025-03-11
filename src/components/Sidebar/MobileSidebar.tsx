import React, { useCallback, useContext, useState } from "react";
import {
  EnhancedPublicUser,
  FiltersState,
  PublicUser,
  User,
} from "../../utils/types";
import { SidebarContent } from "./SidebarContent";
import Filters from "../Filters";
import { FaFilter } from "react-icons/fa6";
import CustomSelect from "./CustomSelect";
import { UserContext } from "../../utils/userContext";
import useIsMobile from "../../utils/useIsMobile";

interface MobileSidebarProps {
  recs: EnhancedPublicUser[];
  favs: EnhancedPublicUser[];
  setFilters: React.Dispatch<React.SetStateAction<FiltersState>>;
  defaultFilters: FiltersState;
  setSort: React.Dispatch<React.SetStateAction<string>>;
  sort: string;
  filters: FiltersState;
  disabled: boolean;
  viewRoute: (user: User, otherUser: PublicUser) => void;
  onViewRequest: (userId: string) => void;
}

const MobileSidebar = (props: MobileSidebarProps) => {
  const user = useContext(UserContext);
  const isMobile = useIsMobile();
  const [curOption, setCurOption] = useState<"recommendations" | "favorites">(
    "recommendations"
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const getActiveFilters = () => {
    return {
      days: props.defaultFilters.days !== props.filters.days,
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
  return (
    <div className="z-10 flex h-full flex-shrink-0 flex-col bg-white text-left">
      <div className="relative h-full w-full ">
        <SidebarContent
        userCardList={
            curOption == "recommendations" ? props.recs : props.favs
        }
        subType={curOption}
        disabled={props.disabled}
        onViewRouteClick={props.viewRoute}
        onCardClick={() => {}}
        selectedUser={null}
        onViewRequest={props.onViewRequest}
        />
      </div>
    </div>
  );
};

export default MobileSidebar;
