import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GetServerSidePropsContext, NextPage } from "next";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import addMapEvents from "../utils/map/addMapEvents";
import { useMapInstance, useMapResize } from "../utils/map/useMapInstance";
import Head from "next/head";
import { trpc, realTimeQueryOptions } from "../utils/trpc";
import { browserEnv } from "../utils/env/browser";
import Header, { HeaderOptions } from "../components/Header";
import { useSession } from "next-auth/react";
import { getServerSession } from "next-auth";
import { authOptions } from "./api/auth/[...nextauth]";
import Spinner from "../components/Spinner";
import WelcomeTutorial from "../components/WelcomeTutorial";
import { UserContext } from "../utils/userContext";
import _, { debounce } from "lodash";
import { SidebarPage } from "../components/Sidebar/Sidebar";
import { roleFetchesRecommendations } from "../components/Sidebar/viewerAccess";
import { QueryError } from "../components/QueryError";
import { toQueryState } from "../utils/queryState";
import type { PublicUser, EnhancedPublicUser, User } from "../utils/types";
import { CarpoolAddress, CarpoolFeature, FiltersState } from "../utils/types";
import {
  useGetDirections,
  viewRoute,
  clearDirections,
} from "../utils/map/viewRoute";
import { MapConnectPortal } from "../components/Map/MapConnectPortal";
import useSearch from "../utils/search";
import AddressCombobox from "../components/Map/AddressCombobox";
import updateUserLocation from "../utils/map/updateUserLocation";
import { MapLegend } from "../components/Map/MapLegend";
import { RecentreButton } from "../components/Map/RecentreButton";
import Image from "next/image";
import BlueSquare from "../../public/user-dest.png";
import BlueCircle from "../../public/blue-circle.png";
import VisibilityToggle from "../components/Map/VisibilityToggle";
import updateCompanyLocation from "../utils/map/updateCompanyLocation";
import MessagePanel from "../components/Messages/MessagePanel";
import InactiveBlocker from "../components/Map/InactiveBlocker";
import updateGeoJsonUsers from "../utils/map/updateGeoJsonUsers";
import useIsMobile from "../utils/useIsMobile";
import { runViewRouteClick } from "../utils/map/viewRouteClick";
import { runViewGroupRoute } from "../utils/map/groupRouteClick";
import clearOtherUserMarkers from "../utils/map/clearOtherUserMarkers";
import { isValidCoordinates } from "../utils/map/coordinates";
import {
  isSheetDetentView,
  planExploreSidebar,
  resolveMobileSelectedUser,
  type ExploreSidebarView,
} from "../utils/explore/exploreSidebarView";
import {
  defaultSheetDetent,
  toggleSheetDetent,
  type SheetDetent,
} from "../utils/explore/sheetDetents";
import { useSheetDrag } from "../utils/explore/useSheetDrag";

mapboxgl.accessToken = browserEnv.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

// One direct session lookup, not a self-directed HTTP round trip to
// `/api/auth/session`. `getSession` from `next-auth/react` is the
// *client* helper and was being called here; `getServerSession` reads the cookie
// and queries directly, as `server/router/context.ts` already did.
export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getServerSession(context.req, context.res, authOptions);

  if (!session?.user) {
    return {
      redirect: {
        destination: "/sign-in",
        permanent: false,
      },
    };
  }
  if (!session.user.isOnboarded) {
    return {
      redirect: {
        destination: "/profile/setup",
        permanent: false,
      },
    };
  }

  return {
    props: {},
  };
}

/**
 * The mobile sheet's classes, one entry per view `planExploreSidebar` can
 * return for a mobile viewport. `Exclude<..., "desktop">` is what makes this
 * exhaustive: adding a view without giving it classes is a type error rather
 * than a sheet that renders with no position or height.
 *
 * These live beside the markup rather than beside the decision because that is
 * where every other Tailwind class in this repository lives, and because the
 * decision is worth testing while the styling is not.
 *
 * `hidden` deliberately carries no offset or height. It is `display: none`, so
 * the sheet is out of layout entirely and the message panel underneath is
 * reachable; `collapsed` is the other thing, keeping the box and animating it
 * to nothing for the collapse handle.
 *
 * **The containing block for every offset here is the initial containing
 * block - the viewport - not the map row and not `#map`.** The sheet is
 * `absolute`, and nothing between it and `#__next` is positioned: the row is
 * `flex overflow-hidden h-mobile-row`, and `overflow` does not establish a
 * containing block. Only `position`, `transform`, `filter` and `contain` do.
 * So `bottom-mobile-nav` measures from the viewport's bottom edge and
 * `h-mobile-sheet`'s `100%` resolves against the viewport's height.
 *
 * That is deliberate as of SCRUM-464, and it is why the recentre button was
 * moved *into* `#map` rather than the row being given `relative`: making the
 * row a containing block would have repositioned this sheet and the drag
 * handle as a side effect of placing a button. Anything that needs to be
 * positioned against the map goes inside `#map`, beside `MapLegend`; anything
 * positioned against the viewport stays here. Note the two are not
 * interchangeable - `#map` is `z-0`, so it is also a stacking context, and an
 * element that must paint above something outside it cannot live there.
 *
 * `detail` is capped at `60dvh` on top of its 320px. Without the cap its top
 * edge went negative below about a 380px viewport - at 568x320, an iPhone SE
 * in landscape and still under the 640px mobile breakpoint, the sheet's top
 * was at -60px and the Back button, its first child, was entirely off-screen
 * with no way to scroll to it. The cap is a `max-height`, so the 320px is
 * unchanged at every viewport tall enough for it; `dvh` rather than `vh` per
 * `globals.css`.
 */
const MOBILE_SIDEBAR_CLASSES: Record<
  Exclude<ExploreSidebarView, "desktop">,
  string
> = {
  hidden: "hidden",
  detail: "bottom-mobile-nav h-[320px] max-h-[60dvh]",
  collapsed: "bottom-mobile-nav pointer-events-none h-0 opacity-0",
  half: "bottom-mobile-nav h-mobile-sheet-half",
  expanded: "bottom-mobile-nav h-mobile-sheet",
};

/**
 * Where the drag handle rests, one entry per view that renders it.
 *
 * Exhaustive over the same three detents `SheetDetent` names, so a detent
 * added without a position for its handle is a type error here as well as in
 * the height map above - the pill is the only thing that moves the sheet, and
 * leaving it at the wrong height would strand it over the map or under the
 * navigation.
 *
 * `expanded` and `half` both sit the pill's clearance above their sheet's top
 * edge, composed from one figure in `tailwind.config.js`; `collapsed` has no
 * sheet to sit above, so it clears the navigation instead. While a drag is in
 * flight none of these apply: `useSheetDrag` writes the handle's `bottom`
 * directly so it can ride the edge between detents.
 */
const HANDLE_POSITION_CLASSES: Record<SheetDetent, string> = {
  collapsed: "bottom-above-mobile-nav",
  half: "bottom-half-sheet-handle",
  expanded: "bottom-sheet-handle",
};

/**
 * The empty results a query stands in for until it resolves.
 *
 * Module scope rather than an inline `= []` in the destructuring below,
 * because an inline default is a *new* array on every render. That is what
 * would keep the `useMemo`s over these missing on every render until the query
 * landed - and `extendPublicUser`, whose dependencies are `favorites` and
 * `requests`, would be rebuilt each time and take every memo keyed on it with
 * it. React Query's own `data` is already stable between renders; only the
 * fallback was not.
 */
const NO_USERS: PublicUser[] = [];
const NO_REQUESTS = { sent: [], received: [] };

/** Where the map opens for a VIEWER, who has no company of their own. */
const NEU_LAT = 42.33907;
const NEU_LNG = -71.088748;

const Home: NextPage<any> = () => {
  const { data: session } = useSession();
  const [showTutorial, setShowTutorial] = useState(false);

  const initialFilters: FiltersState = {
    days: 0,
    flexDays: 1,
    startDistance: 20,
    endDistance: 20,
    daysWorking: "",
    startTime: 4,
    endTime: 4,
    startDate: new Date(Date.now()),
    endDate: new Date(Date.now()),
    dateOverlap: 0,
    favorites: false,
    messaged: false,
  };
  const [defaultFilters] = useState<FiltersState>(initialFilters);
  const [filters, setFilters] = useState<FiltersState>(initialFilters);
  const [sort, setSort] = useState<string>("any");
  const [debouncedFilters, setDebouncedFilters] = useState(filters);
  const [otherUser, setOtherUser] = useState<PublicUser | null>(null);
  const isMobile: boolean = useIsMobile();
  // const [mobileSidebarExpanded, setMobileSidebarExpanded] = useState<boolean>(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  /**
   * Where the user has put the explore sheet, or `null` if they have not
   * touched it and its opening position therefore still applies. A tap toggles
   * it, a drag on the handle snaps it - see `utils/explore/sheetDetents.ts`.
   *
   * One value rather than the `isSidebarCollapsed` boolean it replaces,
   * because there are now three positions and two booleans could encode a
   * fourth that does not exist.
   *
   * **The `null` is what makes the opening position role-dependent.** It cannot
   * be a `useState` initial value: the role arrives with `user.me`, which is
   * still in flight on the render that runs this. Nor can it be an effect - one
   * would land a frame late, and that frame is the bug for a VIEWER, whose
   * panel the sheet covers. So the resting detent is *derived* below, once
   * `user` is in scope, and this holds only the override. Same reasoning as
   * `resolveMobileSelectedUser`, which is in that file for the same reason.
   */
  const [sheetDetentOverride, setSheetDetentOverride] =
    useState<SheetDetent | null>(null);

  /**
   * The expanded card, masked to null on desktop.
   *
   * `expandedUserId` above is the raw state and is deliberately awkward to
   * reach for: it is only correct on a mobile viewport, and every read below
   * goes through this instead. `resolveMobileSelectedUser` carries the reason,
   * and why it is derived here rather than cleared by an effect.
   */
  const mobileSelectedUserID = resolveMobileSelectedUser({
    isMobile,
    expandedUserId,
  });

  useEffect(() => {
    const handler = debounce(() => {
      setDebouncedFilters(filters);
    }, 300);

    handler();

    return () => {
      handler.cancel();
    };
  }, [filters]);

  const { data: geoJsonUsers } =
    trpc.mapbox.geoJsonUserList.useQuery(debouncedFilters);

  // Held as whole query objects rather than destructured to `data` alone: the
  // error and loading states are what tell an empty list apart from a failed one.
  const userQuery = trpc.user.me.useQuery();
  const { data: user = null } = userQuery;

  /**
   * Where the sheet is actually resting: what the user chose, or the opening
   * position for their role until they choose something.
   *
   * `defaultSheetDetent` carries why that differs by role - in short, a VIEWER's
   * only interface is the route-search panel and an expanded sheet paints over
   * it from a stacking context the panel cannot reach out of (SCRUM-455).
   */
  const sheetDetent = sheetDetentOverride ?? defaultSheetDetent(user?.role);

  /**
   * The setter every existing call site keeps using, `useState`-shaped so that
   * the updater form still works.
   *
   * That form is load-bearing rather than stylistic - `handleSidebarToggle`
   * relies on it because the handle's click can arrive in the same tick as a
   * drag's release - and a raw `setSheetDetentOverride` would hand the updater
   * the `null`, not the detent on screen. Resolving the default here is what
   * keeps "toggle from where it looks like it is" true on a VIEWER's first tap.
   */
  const setSheetDetent = useCallback(
    (next: SetStateAction<SheetDetent>) =>
      setSheetDetentOverride((override) =>
        typeof next === "function"
          ? next(override ?? defaultSheetDetent(user?.role))
          : next,
      ),
    [user?.role],
  );

  /**
   * The one thing most readers of the detent want to know. `half` reads as
   * open, so the handle offers to hide the list from it exactly as it does
   * from `expanded`.
   */
  const isSheetCollapsed = sheetDetent === "collapsed";

  // `enabled` is the whole of SCRUM-460. A VIEWER's recommendations tab renders
  // a sentence, not cards — `SidebarContent` short-circuits on
  // `viewerModeHidesCards` ahead of its error, loading and empty branches — so
  // every one of the 50 ranked candidates the server built was discarded on
  // arrival, on first mount and again on every client-side navigation back here.
  //
  // `roleFetchesRecommendations` is that same predicate read one layer earlier,
  // which is what keeps the query and the render agreeing by construction. It
  // answers `false` while `user?.role` is still `undefined`, so the request
  // waits for `user.me` rather than racing it; see the note there for why that
  // is a hold and not a permanent disable.
  //
  // Nothing downstream mistakes this for a spinner: React Query v5 defines
  // `isLoading` as `isPending && isFetching`, and a disabled query is not
  // fetching, so `toQueryState` reads it as `ready` with an empty list.
  const recommendationsQuery = trpc.user.recommendations.me.useQuery(
    {
      sort: sort,
      filters: debouncedFilters,
    },
    {
      refetchOnMount: true,
      enabled: roleFetchesRecommendations(user?.role),
    },
  );
  const { data: recommendations = NO_USERS } = recommendationsQuery;

  const favoritesQuery = trpc.user.favorites.me.useQuery(undefined, {
    refetchOnMount: true,
  });
  const { data: favorites = NO_USERS } = favoritesQuery;

  // `"always"` rather than `true`, and kept deliberately.
  //
  // The global default is `refetchOnMount: false`, and this is the only query
  // that opts out of it. It has to: it is the sole source of conversation
  // history and of the per-card unread dot, and both change out of band - the
  // other person replies over Pusher, or `markMessagesAsRead` fires from a
  // thread the user had open. Returning to `/` from `/profile` is a client-side
  // navigation, so without this the cached payload is served as-is and the
  // Requests tab can show a stale "New!" for a message already read, or miss a
  // reply entirely. `true` would still respect `staleTime`; `"always"` does not.
  //
  // The six explicit `utils.user.requests.me.invalidate()` call sites cover
  // mutations this tab initiates. They cannot cover what happened while the
  // user was on another page, which is what this is for.
  //
  // It also means the payload is re-fetched on every navigation to `/`, which
  // is why the projection above it matters: the narrowing in
  // `user.requests.me` is what makes paying this on every mount
  // reasonable.
  //
  // `realTimeQueryOptions` extends that same reasoning to the tab coming back
  // from the background. "What happened while the user was on another page" and
  // "what happened while the phone was locked" are the same gap; only the
  // former fires a mount. Bounded by the projection above for the same reason.
  const requestsQuery = trpc.user.requests.me.useQuery(undefined, {
    refetchOnMount: "always",
    ...realTimeQueryOptions,
  });
  const { data: requests = NO_REQUESTS } = requestsQuery;

  const recsState = toQueryState(recommendationsQuery);
  const favsState = toQueryState(favoritesQuery);
  const requestsState = toQueryState(requestsQuery);
  const utils = trpc.useUtils();

  // Tutorial logic: Show tutorial if user is onboarded but hasn't completed tutorial
  useEffect(() => {
    if (session?.user && user) {
      const shouldShowTutorial =
        session.user.isOnboarded && !session.user.tutorialCompleted;
      setShowTutorial(shouldShowTutorial);
    }
  }, [session, user]);

  const handleTutorialComplete = () => {
    setShowTutorial(false);
  };

  const handleUserSelect = (userId: string) => {
    setSelectedUserId(userId);
    if (userId !== "") {
      setOtherUser(null);
    }
  };

  const [sidebarType, setSidebarType] = useState<HeaderOptions>("explore");
  const [popupUsers, setPopupUsers] = useState<PublicUser[] | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  /**
   * **The map's whole lifecycle.** Body in `utils/map/useMapInstance.ts`.
   *
   * Two effects further down this file used to own this. The first built the
   * map and returned no cleanup, so every unmount left a live WebGL context,
   * its tiles, six `map.on` listeners and a `NavigationControl` behind; the
   * second queued an unthrottled `map.resize()` per `resize` event, with no
   * `clearTimeout`. Both are lifted out for the reason this file keeps lifting
   * things out - a route cannot carry a test - and are covered by
   * `useMapInstance.test.tsx`.
   *
   * The leak was mobile-only in reach. The Profile tab is a `router.push`, so
   * browser Back remounts this page client-side and built another map each
   * time. iOS Safari caps live WebGL contexts at roughly 8-16 and silently
   * drops the oldest, which is the blank map that was being reported.
   *
   * It sits here, rather than beside the effects it replaces, because
   * `mapState` is read by callbacks declared further down and `const` has no
   * hoisting to lean on.
   */
  const mapCenter: [number, number] | null = user
    ? user.role === "VIEWER"
      ? [NEU_LNG, NEU_LAT]
      : [user.companyCoordLng, user.companyCoordLat]
    : null;

  const { map: mapState, isLoaded: mapStateLoaded } = useMapInstance({
    containerId: "map",
    containerRef: mapContainerRef,
    center: mapCenter,
    onLoad: (newMap) => {
      addMapEvents(newMap, setPopupUsers);

      // Initial setting of user and company locations
      if (user && user.role !== "VIEWER") {
        updateUserLocation(newMap, user.startCoordLng, user.startCoordLat);
        updateCompanyLocation(
          newMap,
          user.companyCoordLng,
          user.companyCoordLat,
          user.role,
          user.id,
          user,
          true,
        );
      }
    },
  });

  // `isMobile` as the layout key: its flip swaps the whole layout around the
  // map, and no `resize` event reports that.
  useMapResize(mapState, isMobile);

  const [points, setPoints] = useState<[number, number][]>([]);
  const [companyAddressSuggestions, setCompanyAddressSuggestions] = useState<
    CarpoolFeature[]
  >([]);
  const [startAddressSuggestions, setStartAddressSuggestions] = useState<
    CarpoolFeature[]
  >([]);

  const [companyAddressSelected, setCompanyAddressSelected] =
    useState<CarpoolAddress>({
      place_name: "",
      center: [0, 0],
    });
  const [startAddressSelected, setStartAddressSelected] =
    useState<CarpoolAddress>({
      place_name: "",
      center: [0, 0],
    });

  const [companyAddress, setCompanyAddress] = useState("");
  const updateCompanyAddress = useMemo(
    () => debounce(setCompanyAddress, 250),
    [],
  );

  const [startingAddress, setStartingAddress] = useState("");
  const updateStartingAddress = useMemo(
    () => debounce(setStartingAddress, 250),
    [],
  );

  const extendPublicUser = useCallback(
    (user: PublicUser): EnhancedPublicUser => {
      const incomingReq = requests.received.find(
        (req) => req.fromUser?.id === user.id,
      );
      const outgoingReq = requests.sent.find(
        (req) => req.toUser?.id === user.id,
      );

      return {
        ...user,
        isFavorited: favorites.some((favs) => favs.id === user.id),
        incomingRequest:
          incomingReq?.fromUser && incomingReq?.toUser
            ? (incomingReq as any)
            : undefined,
        outgoingRequest:
          outgoingReq?.fromUser && outgoingReq?.toUser
            ? (outgoingReq as any)
            : undefined,
      };
    },
    [favorites, requests],
  );

  const handleMessageSent = (selectedUserId: string) => {
    utils.user.requests.me.invalidate();
    requestsQuery.refetch();
    setSelectedUserId(selectedUserId);
  };
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const selectedUser: EnhancedPublicUser | null = useMemo(() => {
    if (!selectedUserId || !requests) return null;
    const allRequests = [...requests.sent, ...requests.received];
    for (const request of allRequests) {
      if (!request.fromUser || !request.toUser) continue;

      const user: PublicUser =
        request.fromUser.id === selectedUserId
          ? request.fromUser
          : request.toUser;
      if (user.id === selectedUserId)
        return extendPublicUser(user) as EnhancedPublicUser;
    }
    return null;
  }, [selectedUserId, requests, extendPublicUser]);

  /**
   * The sidebar's single visibility owner.
   *
   * A `useEffect` stood here and imperatively added the `hidden` class to the
   * sidebar node when a conversation opened, reaching through its ref.
   * React assigns the whole `class` attribute rather than merging, so the next
   * re-render that changed this sidebar's `className` - toggling the collapse
   * handle was the easy route - dropped `hidden`, and the effect did not
   * re-apply it because its `[selectedUser, isMobile]` dependencies had not
   * changed. The card list ended up over the open conversation and stayed
   * there. Derived state cannot lose that race; the precedence between the
   * four states is tested in `exploreSidebarView.test.ts`.
   */
  const sidebarView = planExploreSidebar({
    isMobile,
    hasOpenConversation: selectedUser !== null,
    isDetailOpen: mobileSelectedUserID !== null,
    detent: sheetDetent,
  });

  const sidebarRef = useRef<HTMLDivElement>(null);

  /**
   * The four card lists, memoised.
   *
   * These were four bare `.map`s in the render body, and each call to
   * `extendPublicUser` does a `favorites.some()` and two `requests.find()` -
   * so this was O(n x m) work on *every* render of this page. Every render:
   * the 300ms debounce above guards the network call the filter sliders make,
   * not the re-render each `setFilters` causes, so a single slider drag ran
   * all four lists at pointer frequency. On iOS Safari `resize` fires on every
   * URL-bar collapse during an ordinary scroll, which did the same.
   *
   * The identities matter as much as the work. `handleMobileSidebarExpand`
   * lists all four as dependencies, so a fresh array each render defeated its
   * `useCallback` - and the scroll effect below depends on *that*, so it
   * detached and re-attached its listener on every render too.
   */
  const enhancedSentUsers = useMemo(
    () =>
      requests.sent
        .filter((request) => request.toUser !== null)
        .map((request) => extendPublicUser(request.toUser!)),
    [requests.sent, extendPublicUser],
  );

  const enhancedReceivedUsers = useMemo(
    () =>
      requests.received
        .filter((request) => request.fromUser !== null)
        .map((request) => extendPublicUser(request.fromUser!)),
    [requests.received, extendPublicUser],
  );

  const enhancedRecs = useMemo(
    () => recommendations.map(extendPublicUser),
    [recommendations, extendPublicUser],
  );

  const enhancedFavs = useMemo(
    () => favorites.map(extendPublicUser),
    [favorites, extendPublicUser],
  );

  /**
   * **View Route.** The body lives in `utils/map/viewRouteClick.ts` - see the
   * header there for why, and `viewRoutePlan.ts` for the branch decision it
   * used to get wrong.
   */
  const onViewRouteClick = useCallback(
    (user: User, clickedUser: PublicUser) => {
      runViewRouteClick({
        user,
        clickedUser,
        map: mapState,
        geoJsonUsers,
        selectedUserId,
        startAddressSelected,
        companyAddressSelected,
        isMobile,
        setOtherUser,
        setPoints,
      });
    },
    [
      geoJsonUsers,
      selectedUserId,
      companyAddressSelected,
      startAddressSelected,
      mapState,
      isMobile,
    ],
  );

  /**
   * **Preview Group Route.** The body lives in `utils/map/groupRouteClick.ts` -
   * see the header there for why, and `groupRouteWaypoints.ts` for the pickup
   * and dropoff ordering it used to hold inline.
   */
  const onViewGroupRoute = useCallback(
    (driver: PublicUser, riders: PublicUser[]) => {
      // Narrows `user` for the call below; `runViewGroupRoute` makes the same
      // check against the map. Logged rather than returned silently, which is
      // what the handler did before it was extracted.
      if (!user) {
        console.error("Map or user not available for group route viewing");
        return;
      }

      runViewGroupRoute({
        user,
        driver,
        riders,
        map: mapState,
        setPoints,
      });
    },
    [mapState, user],
  );

  /**
   * The tap path, unchanged in behaviour: the sheet goes between collapsed and
   * fully expanded, and `half` is reachable only by dragging. The updater form
   * rather than a read of the current value, because the handle's click can
   * arrive in the same tick as a drag's release.
   */
  const handleSidebarToggle = () => {
    setSheetDetent(toggleSheetDetent);
  };

  /**
   * The drag gesture on the handle.
   *
   * The pill is drawn as a grabber - the standard "drag me" affordance on both
   * mobile platforms - and until this hook existed it only answered a tap,
   * which is what the product owner reported. The tap path is passed in
   * unchanged and still runs; the hook suppresses it only for the click that
   * follows a real drag, which would otherwise collapse a sheet the user had
   * just released at `half`.
   */
  const sheetDrag = useSheetDrag({
    sheetRef: sidebarRef,
    view: sidebarView,
    onDetentChange: setSheetDetent,
    onTap: handleSidebarToggle,
  });

  const handleMobileSidebarExpand = useCallback(
    (userId?: string) => {
      if (userId) {
        setExpandedUserId(userId);
        setSheetDetent("expanded"); // Expand when viewing details
        const allUsers = [
          ...enhancedRecs,
          ...enhancedFavs,
          ...enhancedSentUsers,
          ...enhancedReceivedUsers,
        ];
        const selectedPublicUser = allUsers.find((u) => u.id === userId);

        if (selectedPublicUser && user && mapState && mapStateLoaded) {
          onViewRouteClick(user, selectedPublicUser);
        }
      } else {
        setExpandedUserId(null);
      }
    },
    [
      enhancedRecs,
      enhancedFavs,
      enhancedSentUsers,
      enhancedReceivedUsers,
      user,
      mapState,
      mapStateLoaded,
      onViewRouteClick,
      setExpandedUserId,
      // Newly a real dependency. `setSheetDetent` used to be the `useState`
      // setter, which React guarantees is stable; it is now a `useCallback`
      // that closes over the role, so omitting it would pin this callback to
      // the setter from before `user.me` resolved.
      setSheetDetent,
    ],
  );

  useEffect(() => {
    if (user && user.role !== "VIEWER") {
      // update filter params
      setFilters((prev) => ({
        ...prev,
        startDate: user.coopStartDate ? user.coopStartDate : prev.startDate,
        endDate: user.coopEndDate ? user.coopEndDate : prev.endDate,
        daysWorking: user.daysWorking,
      }));
    }
  }, [user]);

  useEffect(() => {
    if (mapState && geoJsonUsers && mapStateLoaded) {
      updateGeoJsonUsers(mapState, geoJsonUsers);
    }
  }, [mapState, geoJsonUsers, mapStateLoaded]);

  useEffect(() => {
    setSelectedUserId(null);
    // Clear other user and related route data when sidebar type changes
    setOtherUser(null);
    // Reset the sheet's position when switching tabs - to the opening position
    // for this role, by dropping the override, rather than to a hard-coded
    // `expanded`. Two reasons. This effect also runs on mount and again when
    // `mapState` first arrives, so a literal here would have overwritten the
    // role default moments after the page settled and put a VIEWER straight
    // back under the sheet. And "reset" reads as "forget where the user put
    // it", which is what clearing the override says.
    setSheetDetentOverride(null);
    // Changing tab drops every other user's pin along with the route they
    // belonged to. This block predates the extraction and could never run -
    // the state it tested was only ever set from an unreachable branch - so a
    // pin genuinely did survive a tab change. That was fixed for the one
    // pin the page was tracking; the sweep covers the group preview's too,
    // which were never tracked at all.
    if (mapState) {
      clearOtherUserMarkers(mapState);
      clearDirections(mapState);
    }
  }, [sidebarType, mapState]);

  // initial route rendering
  useEffect(() => {
    if (
      user &&
      !otherUser &&
      mapState &&
      mapStateLoaded &&
      (user.role !== "VIEWER" ||
        (startAddressSelected.center[0] !== 0 &&
          companyAddressSelected.center[0] !== 0))
    ) {
      // Validate coordinates before proceeding
      const isViewerWithValidCoords =
        user.role === "VIEWER" &&
        isValidCoordinates(
          startAddressSelected.center[0],
          startAddressSelected.center[1],
        ) &&
        isValidCoordinates(
          companyAddressSelected.center[0],
          companyAddressSelected.center[1],
        );

      const isNonViewerWithValidCoords =
        user.role !== "VIEWER" &&
        isValidCoordinates(user.startCoordLng, user.startCoordLat) &&
        isValidCoordinates(user.companyCoordLng, user.companyCoordLat);

      if (!isViewerWithValidCoords && !isNonViewerWithValidCoords) {
        console.error("Invalid coordinates for initial route rendering");
        return;
      }

      let userCoord = {
        startLat: user.startCoordLat,
        startLng: user.startCoordLng,
        endLat: user.companyCoordLat,
        endLng: user.companyCoordLng,
      };

      if (user.role == "VIEWER") {
        userCoord = {
          startLng: startAddressSelected.center[0],
          startLat: startAddressSelected.center[1],
          endLng: companyAddressSelected.center[0],
          endLat: companyAddressSelected.center[1],
        };
      }

      // About to draw the viewer's own route, so every other user's pin is now
      // orphaned - `viewRoute` clears their popup and marker, but those are the
      // other system and it leaves these layers standing.
      clearOtherUserMarkers(mapState);
      const viewProps = {
        user,
        otherUser: undefined,
        map: mapState,
        userCoord,
        isMobile,
      };

      // Set initial points for directions or route viewing
      setPoints([
        [userCoord.startLng, userCoord.startLat],
        [userCoord.endLng, userCoord.endLat],
      ]);
      viewRoute(viewProps);
    }
  }, [
    companyAddressSelected,
    mapState,
    mapStateLoaded,
    otherUser,
    startAddressSelected,
    user,
    isMobile,
  ]);
  useSearch({
    value: companyAddress,
    type: "address",
    setFunc: setCompanyAddressSuggestions,
  });

  useSearch({
    value: startingAddress,
    type: "address",
    setFunc: setStartAddressSuggestions,
  });
  useGetDirections({ points: points, map: mapState! });

  // A failed `user.me` used to leave `data` undefined behind this spinner
  // forever, which was indistinguishable from the app being down and offered
  // nothing to do about it.
  if (userQuery.isError) {
    return (
      <QueryError
        variant="page"
        subject="your profile"
        onRetry={() => {
          void userQuery.refetch();
        }}
      />
    );
  }

  if (!user) {
    return <Spinner />;
  }

  /**
   * The route search a VIEWER gets instead of a recommendation list.
   *
   * It is that role's entire interface and had never been given a mobile
   * treatment. Two defects, both styling-only, so both are fixed as `desktop:`
   * overrides on top of mobile-first base classes rather than with an
   * `isMobile` ternary - the direction SCRUM-415 settled on.
   *
   * **Width.** The floor was an unconditional `min-w-[25rem]`. 400px, plus
   * `m-2` either side, is a 416px minimum on a viewport that is commonly 375px
   * or 360px, and a `min-width` cannot shrink - so the panel ran off the screen
   * with no way to reach its right-hand edge. Mobile now takes its width from
   * the container, less that margin, and the 400px floor applies from the
   * `desktop:` breakpoint up, where it always held.
   *
   * **Vertical offset.** The panel and the map legend were both flush into the
   * map's top-left corner at the same `z-10`, and `MapLegend` renders second,
   * so it painted over this panel's heading and its start-address input. The
   * panel moves down rather than the legend moving aside: the legend and the
   * recentre button would otherwise have to know that a viewer box exists, and
   * keeping that role check here is the coupling their own placement rules
   * exist to avoid.
   *
   * 4.25rem clears the legend's collapsed row, which measures 70px - `top-2`,
   * plus `p-2` either side of a `min-h-11` toggle, plus its 1px border - and
   * this panel's own `m-2` leaves 6px between the two. **Declared, not
   * measured:** jsdom computes no geometry, so nothing in the suite can assert
   * it, and expanding the legend still paints its rows over the panel because
   * the two share a z-index and the legend is the later sibling.
   *
   * **Still inside a stacking context this panel cannot escape, and that is
   * now handled elsewhere: SCRUM-455.** On mobile the explore sheet covers
   * everything below the top 5.5rem of the map row. It is `z-20` and a sibling
   * of the map area, while this panel sits inside `#map`, which is `relative
   * z-0` - so no z-index written here can lift the panel above it, and the
   * offset above puts the heading under that line too. The fix was not to move
   * either box but to stop the sheet claiming the space unasked: it now opens
   * `collapsed` for a VIEWER, per `defaultSheetDetent`. **So the constraint
   * above is unchanged** - adding a `z-` class here still buys nothing, and a
   * future change that puts the sheet back over this panel has to answer for
   * the detent, not the z-index.
   */
  const viewerBox = (
    <div className="desktop:top-0 desktop:w-auto desktop:min-w-[25rem] absolute top-[4.25rem] left-0 z-10 m-2 flex w-[calc(100%-1rem)] flex-col rounded-xl bg-white p-4 shadow-lg">
      <h2 className="mb-4 text-xl">Search my route</h2>
      <div className="flex items-center space-x-4">
        <Image
          className="h-8 w-8"
          src={BlueCircle}
          alt="start"
          width={32}
          height={32}
        />
        <AddressCombobox
          name="startAddress"
          placeholder="Enter start address"
          addressSelected={startAddressSelected}
          addressSetter={setStartAddressSelected}
          addressSuggestions={startAddressSuggestions}
          addressUpdater={updateStartingAddress}
          className="flex-1"
        />
      </div>

      <div className="mt-4 flex items-center space-x-4">
        <Image
          className="h-8 w-8"
          alt="end"
          src={BlueSquare}
          width={32}
          height={42}
        />
        <AddressCombobox
          name="companyAddress"
          placeholder="Enter company address"
          addressSelected={companyAddressSelected}
          addressSetter={setCompanyAddressSelected}
          addressSuggestions={companyAddressSuggestions}
          addressUpdater={updateCompanyAddress}
          className="flex-1"
        />
      </div>
      <div className="flex items-center space-x-4">
        <VisibilityToggle
          map={mapState}
          style={{
            width: "100%",
            marginTop: "20px",
            backgroundColor: "white",
            borderRadius: "8px",
            borderColor: "black",
          }}
        />
      </div>
    </div>
  );
  return (
    <>
      <UserContext.Provider value={user}>
        {/* The viewport meta this used to carry now lives in `_app.tsx`, which
            covers every page and is where `viewport-fit=cover` has to go. */}
        <Head>
          <title>CarpoolNU</title>
        </Head>

        {/* Tutorial overlay for first-time users */}
        {showTutorial && (
          <WelcomeTutorial onComplete={handleTutorialComplete} />
        )}

        {/* A max-height utility named for the viewport used to sit on this div
            and has been removed rather than converted, because it never
            constrained anything. It compiled to a `100vh` ceiling, and this
            element is a direct child of `#__next`, which `globals.css` gives a
            `100dvh` height - and the dynamic viewport is by definition never
            larger than the large one, so that ceiling cannot clip this height
            at any viewport. SCRUM-483 measured it in Chromium, found it inert,
            and deferred the removal to SCRUM-485.

            It was the last `vh` length in the shipped bundle, and the only one
            `viewportUnits.test.ts` could not see: that guard reads source
            spellings, and the source named the viewport instead of the unit.
            Removing it closes the exemption that file's docblock used to
            record, and the guard now rejects those aliases outright, so the
            gap cannot reopen.

            The utility is described here rather than spelled, and that is not
            squeamishness: Tailwind v4 scans this file, comments included, so
            writing the name would emit the very declaration being removed.
            `layoutFixtures.ts` and `breakpoints.js` keep the same discipline
            for the same reason. */}
        <div className="m-0 h-full w-full">
          {!isMobile && (
            <Header
              data={{
                sidebarValue: sidebarType,
                setSidebar: setSidebarType,
                disabled: user.status === "INACTIVE" && user.role !== "VIEWER",
              }}
              onViewGroupRoute={onViewGroupRoute}
            />
          )}
          {/* `h-mobile-row` is the viewport less the navigation - see
              `tailwind.config.js`. It no longer reserves a banner allowance:
              SCRUM-503 removed the "use desktop instead" bar this row used to
              be pushed down by.

              The desktop arm is `h-content-row`, which is its own token and not
              this one: it reserves the *top* header, a different quantity from
              the bottom navigation and outside the bottom bar's own height. On
              mobile that reservation means nothing at all, because the header
              renders as the bottom bar instead - the header's share happened to
              equal the bar at exactly one viewport height (~694px) and drifted
              either side of it, which is why the two arms are separate tokens
              rather than one with a term switched.

              Both arms were bracketed percentages once. SCRUM-496 moved the
              desktop one into `tailwind.config.js` when the bar gained a 44px
              floor and its complement stopped being expressible as a second
              percentage. */}
          <div
            className={`flex overflow-hidden ${
              isMobile ? "h-mobile-row" : "h-content-row"
            }`}
          >
            {/* Shown exactly when the sheet is in a state this handle can
                toggle. That is the same condition as before for `isMobile` and
                the detail view, and newly excludes an open conversation: the
                handle used to sit there over the message panel toggling a
                sheet the user could not see.

                The three-way `||` this used to spell out is now
                `isSheetDetentView`, which `useSheetDrag` checks before starting
                a gesture. Sharing the predicate is the point: the handle
                rendering somewhere the drag refuses to run is precisely what
                SCRUM-459 was. */}
            {isSheetDetentView(sidebarView) &&
              (sidebarType === "explore" || sidebarType === "requests") && (
                <button
                  type="button"
                  {...sheetDrag.handleProps}
                  aria-expanded={!isSheetCollapsed}
                  aria-label={
                    isSheetCollapsed ? "Show the list" : "Hide the list"
                  }
                  /* `py-4.5` is the tap target, not decoration.
                     The visible bar is `h-2`, so 4.5 + 2 + 4.5 = 11 spacing
                     units = 44px at this scale - the size Apple's HIG and
                     WCAG 2.5.5 ask of a touch control. It was 12px of inline
                     padding, giving 32px: enough for WCAG 2.5.8 at AA, short
                     of the guideline this control should meet as the primary
                     way to show and hide the list on a phone.

                     Kept on the spacing scale rather than an arbitrary
                     pixel value so the whole control stays proportional if
                     `--spacing` ever changes: the bar and its target are then
                     still 2 and 11 units. The arbitrary form is deliberately
                     not spelled out here - Tailwind scans this file for
                     class-like strings and would emit whichever one a comment
                     names. Do not shrink this to make the
                     handle look smaller - shrink the `h-2` span instead, and
                     leave the padding to hold the target open.

                     `touch-none` is `touch-action: none`, and it is what lets
                     the drag exist: without it the browser claims a vertical
                     swipe as a scroll before any handler sees it. It is scoped
                     to the handle, so the list inside the sheet scrolls as it
                     always did.

                     The transition is dropped while a drag is in flight -
                     `useSheetDrag` writes `bottom` on every pointer move, and
                     a 300ms ease on that would leave the pill trailing the
                     thumb. `group` is here for the pill's press state
                     below. */
                  className={`group focus-visible:outline-northeastern-red absolute left-1/2 z-30 -translate-x-1/2 transform cursor-pointer touch-none py-4.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    sheetDrag.isDragging ? "" : "transition-all duration-300"
                  } ${HANDLE_POSITION_CLASSES[sheetDetent]}`}
                >
                  {/* `group-active` rather than `hover`, which was the bug's
                      smaller half: a hover style applied by a tap persists on
                      iOS Safari until the next tap elsewhere, so the pill
                      stayed darkened and read as still-pressed. `:active`
                      clears on release, works for a mouse as well as a finger,
                      and - taken from the group rather than the span - covers
                      the whole 44px target rather than only the visible
                      8px. It also darkens for the duration of a drag, which
                      is the feedback a gesture wants. */}
                  <span className="block h-2 w-20 rounded-full bg-gray-500 shadow-xs transition-colors group-active:bg-gray-600"></span>
                </button>
              )}
            {/* While a drag is in flight the sheet gets neither a height
                class nor a transition: `useSheetDrag` writes `style.height`
                on every pointer move, and an animation towards a detent the
                gesture has already left would fight it. Dropping
                `MOBILE_SIDEBAR_CLASSES` also drops `collapsed`'s `opacity-0`
                and `pointer-events-none`, so a sheet dragged open from
                collapsed is visible on the way up rather than at the end. */}
            <div
              ref={sidebarRef}
              className={
                sidebarView === "desktop"
                  ? "relative w-[25rem]"
                  : `absolute left-0 z-20 w-full overflow-y-auto rounded-t-3xl border-2 border-black bg-white shadow-lg ${
                      mobileSelectedUserID !== null
                        ? "overscroll-y-contain"
                        : ""
                    } ${
                      sheetDrag.isDragging
                        ? "bottom-mobile-nav"
                        : `transition-all duration-300 ${MOBILE_SIDEBAR_CLASSES[sidebarView]}`
                    }`
              }
            >
              {mobileSelectedUserID !== null && (
                <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50 px-3 py-2">
                  <button
                    onClick={() => handleMobileSidebarExpand()}
                    className="text-northeastern-red flex items-center"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="mr-1"
                      aria-hidden="true"
                    >
                      <polyline points="15 18 9 12 15 6"></polyline>
                    </svg>
                    <span className="font-medium">Back</span>
                  </button>
                </div>
              )}

              {mapState && (
                <SidebarPage
                  setSort={setSort}
                  sort={sort}
                  setFilters={setFilters}
                  filters={filters}
                  defaultFilters={defaultFilters}
                  sidebarType={sidebarType}
                  role={user.role}
                  map={mapState}
                  recs={enhancedRecs}
                  favs={enhancedFavs}
                  received={enhancedReceivedUsers}
                  sent={enhancedSentUsers}
                  recsState={recsState}
                  favsState={favsState}
                  requestsState={requestsState}
                  onViewRouteClick={onViewRouteClick}
                  onUserSelect={handleUserSelect}
                  selectedUser={selectedUser}
                  mobileSelectedUser={mobileSelectedUserID}
                  handleMobileExpand={handleMobileSidebarExpand}
                  onViewGroupRoute={onViewGroupRoute}
                  collapseSidebar={(collapsed) =>
                    setSheetDetent(collapsed ? "collapsed" : "expanded")
                  }
                />
              )}
            </div>

            <div className="relative flex-auto">
              {/* Message Panel */}
              {selectedUser && (
                <div className="pointer-events-none absolute inset-0 z-10 h-full w-full">
                  <MessagePanel
                    selectedUser={selectedUser}
                    onMessageSent={handleMessageSent}
                    onViewRouteClick={onViewRouteClick}
                    onCloseConversation={handleUserSelect}
                  />
                </div>
              )}

              {/* Map Container */}
              <div
                ref={mapContainerRef}
                id="map"
                className="pointer-events-auto relative z-0 h-full w-full flex-auto"
              >
                {user.role === "VIEWER" && viewerBox}
                {/* Ungated item 3. On mobile it moves to
                    the top of the map and starts collapsed - the bottom is
                    claimed by the navigation, the explore sheet and Mapbox's
                    own controls. The component owns that decision. */}
                <MapLegend role={user.role} />
                {/* Reachable on mobile item 3, and lifted into
                    its own component so that reachability is assertable - see
                    its docblock for why the mobile placement is not from the
                    phase 1 tokens.

                    Inside `#map` rather than beside it. It is `absolute`, and
                    it used to render as a sibling of this container with
                    nothing positioned between it and `#__next` - so `top-2
                    right-2` resolved against the initial containing block,
                    which is the viewport, not the map. That put its 44px box
                    16px under `MobileBanner`; the banner is `fixed` at a
                    z-index of 9999, so `elementFromPoint` at the button's top
                    edge returned the banner and the overlap cost the hit test,
                    not just the paint. `MapLegend` above was placed inside
                    from the start and has always been clear of the banner,
                    because this container starts below it.

                    The banner's z-index is spelled out in words above rather
                    than as its Tailwind class, deliberately: v4 scans this
                    whole repository for class names, comments included, so
                    naming that utility here would ship a rule nothing uses.
                    Confirmed by selector-set diff on the compiled stylesheet.

                    Moved rather than making the row `relative`, which would
                    have fixed this button by changing the containing block of
                    the sheet and the drag handle as a side effect - see
                    `MOBILE_SIDEBAR_CLASSES`. This container's `z-0` does make
                    it a stacking context, so nothing inside can paint above
                    something outside it; that costs this button nothing,
                    because the only thing it needed to clear it now clears
                    geometrically. */}
                <RecentreButton
                  onRecentre={() =>
                    mapState?.flyTo({
                      center: [user.companyCoordLng, user.companyCoordLat],
                      essential: true,
                    })
                  }
                />
                {/* Ungated item 2. The map's click handlers
                    always ran and always set `popupUsers`; with this behind
                    `!isMobile` a phone tap set state that nothing read and
                    nothing could clear again. The component picks its own
                    presentation per viewport. */}
                <MapConnectPortal
                  otherUsers={popupUsers}
                  extendUser={extendPublicUser}
                  onViewRouteClick={onViewRouteClick}
                  onViewRequest={handleUserSelect}
                  onClose={() => {
                    setPopupUsers(null);
                  }}
                />
                {user.status === "INACTIVE" && user.role !== "VIEWER" && (
                  <InactiveBlocker />
                )}
              </div>
              {isMobile && (
                <Header
                  data={{
                    sidebarValue: sidebarType,
                    setSidebar: setSidebarType,
                    disabled:
                      user.status === "INACTIVE" && user.role !== "VIEWER",
                    // Dropping the override rather than setting "expanded"
                    // directly, so a reselect resolves to the same resting
                    // position a fresh switch into My Group would - see
                    // `defaultSheetDetent`. There used to be a floating pill
                    // for this; it is gone, and reselecting the already-active
                    // tab is now the only way back in once the header's Close
                    // button has collapsed the sheet.
                    onMyGroupReselected: () => {
                      setSheetDetentOverride(null);
                      // The removed pill cleared this defensively too, and
                      // there is no evidence it was ever actually reachable
                      // here - kept rather than dropped, since it costs
                      // nothing and a future path in is easier to reason
                      // about if this invariant already holds.
                      setExpandedUserId(null);
                    },
                  }}
                  onViewGroupRoute={onViewGroupRoute}
                />
              )}
            </div>
          </div>
        </div>
      </UserContext.Provider>
    </>
  );
};

export default Home;
