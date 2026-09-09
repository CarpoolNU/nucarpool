import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GetServerSidePropsContext, NextPage } from "next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiFocus3Line } from "react-icons/ri";
import addMapEvents from "../utils/map/addMapEvents";
import Head from "next/head";
import { trpc } from "../utils/trpc";
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
import { QueryError } from "../components/QueryError";
import { toQueryState } from "../utils/queryState";
import type {
  PublicUser,
  EnhancedPublicUser,
  Request,
  User,
} from "../utils/types";
import {
  CarpoolAddress,
  CarpoolFeature,
  FiltersState,
  GeoJsonUsers,
} from "../utils/types";
import { Role } from "@prisma/client";
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
  const isMapInitialized = useRef(false);
  const [mapStateLoaded, setMapStateLoaded] = useState(false);
  const isMobile: boolean = useIsMobile();
  // const [mobileSidebarExpanded, setMobileSidebarExpanded] = useState<boolean>(false);
  const [mobileSelectedUserID, setmobileSelectedUserID] = useState<
    string | null
  >(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

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

  const recommendationsQuery = trpc.user.recommendations.me.useQuery(
    {
      sort: sort,
      filters: debouncedFilters,
    },
    { refetchOnMount: true },
  );
  const { data: recommendations = [] } = recommendationsQuery;

  const favoritesQuery = trpc.user.favorites.me.useQuery(undefined, {
    refetchOnMount: true,
  });
  const { data: favorites = [] } = favoritesQuery;

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
  const requestsQuery = trpc.user.requests.me.useQuery(undefined, {
    refetchOnMount: "always",
  });
  const { data: requests = { sent: [], received: [] } } = requestsQuery;

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
      if (sidebarRef.current) {
        sidebarRef.current.classList.remove("hidden");
      }
    }
  };

  const [mapState, setMapState] = useState<mapboxgl.Map>();
  const [sidebarType, setSidebarType] = useState<HeaderOptions>("explore");
  const [popupUsers, setPopupUsers] = useState<PublicUser[] | null>(null);
  const mapContainerRef = useRef(null);
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

  useEffect(() => {
    if (isMobile && sidebarRef.current) {
      if (selectedUser) {
        sidebarRef.current.classList.add("hidden");
      } else {
        sidebarRef.current.classList.remove("hidden");
      }
    }
  }, [selectedUser, isMobile]);

  const sidebarRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef<number>(0);

  const enhancedSentUsers = requests.sent
    .filter((request) => request.toUser !== null)
    .map((request) => extendPublicUser(request.toUser!));

  const enhancedReceivedUsers = requests.received
    .filter((request) => request.fromUser !== null)
    .map((request) => extendPublicUser(request.fromUser!));
  const enhancedRecs = recommendations.map(extendPublicUser);
  const enhancedFavs = favorites.map(extendPublicUser);

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
      if (!user) return;

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

  const handleSidebarToggle = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  const handleMobileSidebarExpand = useCallback(
    (userId?: string) => {
      if (userId) {
        setmobileSelectedUserID(userId);
        setIsSidebarCollapsed(false); // Expand when viewing details
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
        setmobileSelectedUserID(null);
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
      setmobileSelectedUserID,
    ],
  );

  useEffect(() => {
    const handleScroll = (e: Event) => {
      if (!isMobile || !sidebarRef.current || mobileSelectedUserID === null)
        return;

      const element = e.target as HTMLDivElement;
      const scrollTop = element.scrollTop;

      if (scrollTop < lastScrollTop.current && scrollTop < 10) {
        handleMobileSidebarExpand();
      }

      lastScrollTop.current = scrollTop;
    };

    const sidebarElement = sidebarRef.current;
    if (sidebarElement && isMobile) {
      sidebarElement.addEventListener("scroll", handleScroll);
    }

    return () => {
      if (sidebarElement) {
        sidebarElement.removeEventListener("scroll", handleScroll);
      }
    };
  }, [isMobile, mobileSelectedUserID, sidebarRef, handleMobileSidebarExpand]);

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
    // Map initialization
    if (!isMapInitialized.current && user && mapContainerRef.current) {
      isMapInitialized.current = true;
      const isViewer = user.role === "VIEWER";
      const neuLat = 42.33907;
      const neuLng = -71.088748;
      const newMap = new mapboxgl.Map({
        container: "map",
        style: "mapbox://styles/mapbox/light-v10",
        center: isViewer
          ? [neuLng, neuLat]
          : [user.companyCoordLng, user.companyCoordLat],
        zoom: 8,
      });

      newMap.on("load", () => {
        newMap.setMaxZoom(13);
        setMapState(newMap);
        addMapEvents(newMap, setPopupUsers);

        // Initial setting of user and company locations
        if (user.role !== "VIEWER") {
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
        setMapStateLoaded(true);
      });
    }
  }, [mapContainerRef, user]);

  useEffect(() => {
    if (!mapState) return;

    const handleResize = () => {
      // small delay to ensure container has resized
      setTimeout(() => {
        if (mapState) {
          mapState.resize();
        }
      }, 100);
    };

    // resize when window size changes
    window.addEventListener("resize", handleResize);

    handleResize();

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [mapState, isMobile]);

  useEffect(() => {
    if (mapState && geoJsonUsers && mapStateLoaded) {
      updateGeoJsonUsers(mapState, geoJsonUsers);
    }
  }, [mapState, geoJsonUsers, mapStateLoaded]);

  useEffect(() => {
    setSelectedUserId(null);
    // Clear other user and related route data when sidebar type changes
    setOtherUser(null);
    // Reset collapsed state when switching tabs
    setIsSidebarCollapsed(false);
    // Changing tab drops every other user's pin along with the route they
    // belonged to. This block existed before SCRUM-379 and could never run -
    // the state it tested was only ever set from an unreachable branch - so a
    // pin genuinely did survive a tab change. SCRUM-379 fixed that for the one
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

  // Create a mobile banner component that will be added to the DOM
  const MobileBanner = () => {
    if (!isMobile) return null;

    return (
      <div
        className="absolute top-0 right-0 left-0 z-[9999] bg-yellow-100 px-4 py-1 text-center text-xs text-black"
        style={{
          width: "100%",
          position: "fixed",
          top: 0,
          zIndex: 9999,
        }}
      >
        For the full experience, try using CarpoolNU on desktop
      </div>
    );
  };

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

  const viewerBox = (
    <div className="absolute top-0 left-0 z-10 m-2 flex min-w-[25rem] flex-col rounded-xl bg-white p-4 shadow-lg">
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
        <Head>
          <title>CarpoolNU</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>

        {/* Always render the banner outside of other containers */}
        <MobileBanner />

        {/* Tutorial overlay for first-time users */}
        {showTutorial && (
          <WelcomeTutorial onComplete={handleTutorialComplete} />
        )}

        <div className="m-0 h-full max-h-screen w-full">
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
          <div
            className={`flex h-[91.5%] overflow-hidden ${isMobile ? "mt-5" : ""}`}
          >
            {isMobile &&
              (sidebarType === "explore" || sidebarType === "requests") &&
              mobileSelectedUserID === null && (
                <button
                  type="button"
                  onClick={handleSidebarToggle}
                  aria-expanded={!isSidebarCollapsed}
                  aria-label={
                    isSidebarCollapsed ? "Show the list" : "Hide the list"
                  }
                  className={`focus-visible:outline-northeastern-red absolute left-1/2 z-30 -translate-x-1/2 transform cursor-pointer transition-all duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    isSidebarCollapsed
                      ? "bottom-16"
                      : "bottom-[calc(100%-6rem)]"
                  }`}
                  style={{ padding: "12px 0" }}
                >
                  <span className="block h-2 w-20 rounded-full bg-gray-500 shadow-xs transition-colors hover:bg-gray-600"></span>
                </button>
              )}
            <div
              ref={sidebarRef}
              className={`${
                isMobile
                  ? `absolute left-0 z-20 w-full overflow-y-auto rounded-t-3xl border-2 border-black bg-white shadow-lg transition-all duration-300 ${
                      mobileSelectedUserID !== null
                        ? "bottom-12 h-[320px]"
                        : isSidebarCollapsed
                          ? "pointer-events-none bottom-12 h-0 opacity-0"
                          : "bottom-12 h-[calc(100%-8.5rem)]"
                    }`
                  : "relative w-[25rem]"
              }`}
            >
              {isMobile && mobileSelectedUserID !== null && (
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
                    setIsSidebarCollapsed(collapsed)
                  }
                />
              )}
            </div>

            {!isMobile && (
              <button
                type="button"
                className="absolute right-[8px] bottom-[150px] z-10 flex h-8 w-8 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-xs hover:bg-gray-200"
                aria-label="Recentre the map on your workplace"
                onClick={() =>
                  mapState?.flyTo({
                    center: [user.companyCoordLng, user.companyCoordLat],
                    essential: true,
                  })
                }
              >
                <RiFocus3Line aria-hidden="true" />
              </button>
            )}
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
                {!isMobile && <MapLegend role={user.role} />}
                {!isMobile && (
                  <MapConnectPortal
                    otherUsers={popupUsers}
                    extendUser={extendPublicUser}
                    onViewRouteClick={onViewRouteClick}
                    onViewRequest={handleUserSelect}
                    onClose={() => {
                      setPopupUsers(null);
                    }}
                  />
                )}
                {user.status === "INACTIVE" && user.role !== "VIEWER" && (
                  <InactiveBlocker />
                )}
              </div>
              {/* Mobile: show reopen button when sidebar collapsed and user is on My Group page, to bring back My Group */}
              {isMobile && isSidebarCollapsed && sidebarType === "mygroup" && (
                <button
                  onClick={() => {
                    setSidebarType("mygroup");
                    setIsSidebarCollapsed(false);
                    setmobileSelectedUserID(null);
                  }}
                  className="absolute bottom-16 left-1/2 z-30 flex -translate-x-1/2 transform items-center gap-1 rounded-full border border-gray-300 bg-white/90 px-4 py-2 text-sm font-medium shadow-md transition-colors hover:bg-white"
                  aria-label="Group Details"
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
                  >
                    <polyline points="15 18 9 12 15 6"></polyline>
                  </svg>
                  <span>Group Details</span>
                </button>
              )}
              {isMobile && (
                <Header
                  data={{
                    sidebarValue: sidebarType,
                    setSidebar: setSidebarType,
                    disabled:
                      user.status === "INACTIVE" && user.role !== "VIEWER",
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
