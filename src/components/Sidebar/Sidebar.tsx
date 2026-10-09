import ExploreSidebar from "./ExploreSidebar";
import RequestSidebar from "./RequestSidebar";
import { GroupPage } from "../Group/GroupPage";
import {
  EnhancedPublicUser,
  FiltersState,
  PublicUser,
  User,
} from "../../utils/types";
import { HeaderOptions } from "../Header";
import _ from "lodash";
import React from "react";
import { QueryState } from "../../utils/queryState";

interface SidebarProps {
  sidebarType: HeaderOptions;
  setFilters: React.Dispatch<React.SetStateAction<FiltersState>>;
  setSort: React.Dispatch<React.SetStateAction<string>>;
  sort: string;
  filters: FiltersState;
  defaultFilters: FiltersState;
  map: mapboxgl.Map;
  role: string;
  recs: EnhancedPublicUser[];
  favs: EnhancedPublicUser[];
  received: EnhancedPublicUser[];
  sent: EnhancedPublicUser[];
  recsState: QueryState;
  favsState: QueryState;
  requestsState: QueryState;
  onViewRouteClick: (user: User, otherUser: PublicUser) => void;
  onUserSelect: (userId: string) => void;
  selectedUser: EnhancedPublicUser | null;
  mobileSelectedUser: string | null;
  handleMobileExpand: (userId?: string) => void;
  onViewGroupRoute?: (driver: PublicUser, riders: PublicUser[]) => void;
  collapseSidebar: (collapsed: boolean) => void;
}

export const SidebarPage = (props: SidebarProps) => {
  /*
   * Newest first, without mutating the caller's arrays.
   *
   * Not `props.received.reverse()` / `props.sent.reverse()` in the JSX below.
   * `Array.prototype.reverse` reverses **in place** and returns the same array,
   * so each of those would reverse one of `index.tsx`'s `useMemo` results on
   * every render of this component - and the memo only recomputes when the
   * request data changes. Two renders between two fetches would land the list
   * back in its original order and an odd number would leave it reversed, so
   * cards with equal timestamps would change places on re-renders that have
   * nothing to do with requests. The same arrays are spread into
   * `handleMobileSidebarExpand`'s lookup in `index.tsx`, which would be
   * reordered underneath it as a side effect.
   *
   * **That is invisible in development.** StrictMode renders twice, which
   * applies the reversal an even number of times per commit and lands back on
   * the original order; only production shows it.
   *
   * Memoised rather than copied inline so the reference is stable as well as
   * the order - handing `RequestSidebar` a fresh array on every render would
   * trade a correctness bug for a re-render one.
   */
  const received = React.useMemo(
    () => [...props.received].reverse(),
    [props.received],
  );
  const sent = React.useMemo(() => [...props.sent].reverse(), [props.sent]);

  let disabled = false;
  if (props.role === "VIEWER") {
    disabled = true;
  }
  if (props.sidebarType === "explore") {
    return (
      <ExploreSidebar
        setFilters={props.setFilters}
        setSort={props.setSort}
        sort={props.sort}
        filters={props.filters}
        defaultFilters={props.defaultFilters}
        recs={props.recs}
        favs={props.favs}
        recsState={props.recsState}
        favsState={props.favsState}
        disabled={disabled}
        viewRoute={props.onViewRouteClick}
        onViewRequest={props.onUserSelect}
        mobileSelectedUser={props.mobileSelectedUser}
        handleMobileExpand={props.handleMobileExpand}
      />
    );
  } else if (props.sidebarType === "requests") {
    return (
      <RequestSidebar
        received={received}
        sent={sent}
        requestsState={props.requestsState}
        disabled={disabled}
        viewRoute={props.onViewRouteClick}
        onUserSelect={props.onUserSelect}
        selectedUser={props.selectedUser}
      />
    );
  } else if (props.sidebarType === "mygroup") {
    return (
      <GroupPage
        onClose={() => props.collapseSidebar(true)}
        onViewGroupRoute={props.onViewGroupRoute || (() => {})}
      />
    );
  }
};
