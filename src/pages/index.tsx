import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GetServerSidePropsContext, NextPage } from "next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RiFocus3Line } from "react-icons/ri";
import { ToastProvider } from "react-toast-notifications";
import addMapEvents from "../utils/map/addMapEvents";
import Head from "next/head";
import { trpc } from "../utils/trpc";
import { browserEnv } from "../utils/env/browser";
import Header, { HeaderOptions } from "../components/Header";
import { getSession } from "next-auth/react";
import Spinner from "../components/Spinner";
import { UserContext } from "../utils/userContext";
import _, { debounce } from "lodash";
import { SidebarPage } from "../components/Sidebar/Sidebar";
import {
  CarpoolAddress,
  CarpoolFeature,
  EnhancedPublicUser,
  FiltersState,
  GeoJsonUsers,
  PublicUser,
  Request,
} from "../utils/types";
import { Role, User } from "@prisma/client";
import { useGetDirections, viewRoute, clearDirections } from "../utils/map/viewRoute";
import { MapConnectPortal } from "../components/MapConnectPortal";
import useSearch from "../utils/search";
import AddressCombobox from "../components/Map/AddressCombobox";
import updateUserLocation from "../utils/map/updateUserLocation";
import { MapLegend } from "../components/MapLegend";
import Image from "next/image";
import BlueSquare from "../../public/user-dest.png";
import BlueCircle from "../../public/blue-circle.png";
import VisibilityToggle from "../components/Map/VisibilityToggle";
import updateCompanyLocation from "../utils/map/updateCompanyLocation";
import MessagePanel from "../components/Messages/MessagePanel";
import InactiveBlocker from "../components/Map/InactiveBlocker";
import updateGeoJsonUsers from "../utils/map/updateGeoJsonUsers";
import useIsMobile from "../utils/useIsMobile";

mapboxgl.accessToken = browserEnv.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

export async function getServerSideProps(context: GetServerSidePropsContext) {
  const session = await getSession(context);

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
  const [tempOtherUser, setTempOtherUser] = useState<PublicUser | null>(null);
  const [tempOtherUserMarkerActive, setTempOtherUserMarkerActive] =
    useState(false);
  const [defaultFilters] = useState<FiltersState>(initialFilters);
  const [filters, setFilters] = useState<FiltersState>(initialFilters);
  const [sort, setSort] = useState<string>("any");
  const [debouncedFilters, setDebouncedFilters] = useState(filters);
  const [otherUser, setOtherUser] = useState<PublicUser | null>(null);
  const isMapInitialized = useRef(false);
  const [mapStateLoaded, setMapStateLoaded] = useState(false);
  const isMobile : boolean = useIsMobile();
  // const [mobileSidebarExpanded, setMobileSidebarExpanded] = useState<boolean>(false);
  const [mobileSelectedUserID, setmobileSelectedUserID] = useState<string | null>(null)

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

  const { data: user = null } = trpc.user.me.useQuery();
  const { data: recommendations = [] } = trpc.user.recommendations.me.useQuery(
    {
      sort: sort,
      filters: filters,
    },
    { refetchOnMount: true }
  );
  const { data: favorites = [] } = trpc.user.favorites.me.useQuery(undefined, {
    refetchOnMount: true,
  });
  const requestsQuery = trpc.user.requests.me.useQuery(undefined, {
    refetchOnMount: "always",
  });
  const { data: requests = { sent: [], received: [] } } = requestsQuery;
  const utils = trpc.useContext();

  const handleUserSelect = (userId: string) => {
    setSelectedUserId(userId);
    if (userId !== "") {
      setOtherUser(null);
      if (sidebarRef.current) {
        sidebarRef.current.classList.remove('hidden');
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
    []
  );

  const [startingAddress, setStartingAddress] = useState("");
  const updateStartingAddress = useMemo(
    () => debounce(setStartingAddress, 250),
    []
  );

  const extendPublicUser = useCallback(
    (user: PublicUser): EnhancedPublicUser => {
      const incomingReq: Request | undefined = requests.received.find(
        (req) => req.fromUserId === user.id
      );
      const outgoingReq: Request | undefined = requests.sent.find(
        (req) => req.toUserId === user.id
      );

      return {
        ...user,
        isFavorited: favorites.some((favs) => favs.id === user.id),
        incomingRequest: incomingReq,
        outgoingRequest: outgoingReq,
      };
    },
    [favorites, requests]
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
      const user: any =
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
        sidebarRef.current.classList.add('hidden');
      } else {
        sidebarRef.current.classList.remove('hidden');
      }
    }
  }, [selectedUser, isMobile]);

  const sidebarRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef<number>(0);

  const handleMobileSidebarExpand = (userId?: string) => {
    if (userId) {
      setmobileSelectedUserID(userId);
      const allUsers = [...enhancedRecs, ...enhancedFavs, ...enhancedSentUsers, ...enhancedReceivedUsers];
      const selectedPublicUser = allUsers.find(u => u.id === userId);
      
      if (selectedPublicUser && user && mapState && mapStateLoaded) {
        onViewRouteClick(user, selectedPublicUser);
      }
    } 
    else {
      setmobileSelectedUserID(null);
    }
  };

  useEffect(() => {
    const handleScroll = (e: Event) => {
      if (!isMobile || !sidebarRef.current || mobileSelectedUserID === null) return;
      
      const element = e.target as HTMLDivElement;
      const scrollTop = element.scrollTop;
      
      if (scrollTop < lastScrollTop.current && scrollTop < 10) {
        handleMobileSidebarExpand(); 
      }
      
      lastScrollTop.current = scrollTop;
    };
    
    const sidebarElement = sidebarRef.current;
    if (sidebarElement && isMobile) {
      sidebarElement.addEventListener('scroll', handleScroll);
    }
    
    return () => {
      if (sidebarElement) {
        sidebarElement.removeEventListener('scroll', handleScroll);
      }
    };
  }, [isMobile, mobileSelectedUserID, sidebarRef]);

  

  // Helper function to validate coordinates
  const isValidCoordinates = (lng?: number, lat?: number): boolean => {
    return lng !== undefined && 
           lat !== undefined && 
           !isNaN(lng) && 
           !isNaN(lat) && 
           isFinite(lng) && 
           isFinite(lat);
  };

  const onViewRouteClick = useCallback(
    (user: User, clickedUser: PublicUser) => {
      if (!mapStateLoaded || !mapState || !geoJsonUsers) {
        console.error("Map not fully initialized for route viewing");
        return;
      }
      
      // Validate user and clickedUser have required coordinate properties
      if (!user || !clickedUser || 
          !isValidCoordinates(user.startCoordLng, user.startCoordLat) || 
          !isValidCoordinates(user.companyCoordLng, user.companyCoordLat) || 
          !isValidCoordinates(clickedUser.startCoordLng, clickedUser.startCoordLat) || 
          !isValidCoordinates(clickedUser.companyCoordLng, clickedUser.companyCoordLat)) {
        console.error("Invalid user coordinates for route viewing");
        return;
      }
      
      const isOtherUserInGeoList = geoJsonUsers.features.some(
        (f) => f.properties?.id === clickedUser.id
      );
      const isPrevOtherUserInGeoList = geoJsonUsers.features.some(
        (f) => f.properties?.id === tempOtherUser?.id
      );
      const shouldRemoveMarker =
        tempOtherUserMarkerActive &&
        ((tempOtherUser && tempOtherUser.id !== clickedUser.id) ||
          isPrevOtherUserInGeoList);
      setOtherUser(clickedUser);
      const isViewerAddressSelected =
        companyAddressSelected.place_name !== "" &&
        startAddressSelected.place_name !== "";
      const companyCord: number[] = companyAddressSelected.center;
      const startCord: number[] = startAddressSelected.center;
      const userStartLng = isViewerAddressSelected
        ? startCord[0]
        : user.startCoordLng;
      const userStartLat = isViewerAddressSelected
        ? startCord[1]
        : user.startCoordLat;
      const userCompanyLng = isViewerAddressSelected
        ? companyCord[0]
        : user.companyCoordLng;
      const userCompanyLat = isViewerAddressSelected
        ? companyCord[1]
        : user.companyCoordLat;
      const userCoord =
        !isViewerAddressSelected && user.role === "VIEWER"
          ? undefined
          : {
              startLat: userStartLat,
              startLng: userStartLng,
              endLat: userCompanyLat,
              endLng: userCompanyLng,
            };

      if (user.role !== "VIEWER") {
        updateUserLocation(mapState, userStartLng, userStartLat);
        updateCompanyLocation(
          mapState,
          userCompanyLng,
          userCompanyLat,
          user.role,
          user.id,
          true
        );
      }
      if (shouldRemoveMarker && tempOtherUser) {
        updateCompanyLocation(
          mapState,
          tempOtherUser.companyCoordLng,
          tempOtherUser.companyCoordLat,
          tempOtherUser.role,
          tempOtherUser.id,
          false,
          true
        );
        setTempOtherUserMarkerActive(false);
        setTempOtherUser(null);
      }
      if (!isOtherUserInGeoList && selectedUserId === clickedUser.id) {
        updateCompanyLocation(
          mapState,
          clickedUser.companyCoordLng,
          clickedUser.companyCoordLat,
          clickedUser.role,
          clickedUser.id,
          false,
          false
        );
        setTempOtherUserMarkerActive(true);
        setTempOtherUser(clickedUser);
      } else if (!isOtherUserInGeoList && selectedUserId !== clickedUser.id) {
        setOtherUser(null);
        return;
      }

      const viewProps = {
        user,
        otherUser: clickedUser,
        map: mapState,
        userCoord,
        isMobile
      };

      if (user.role === "RIDER") {
        setPoints([
          [clickedUser.startCoordLng, clickedUser.startCoordLat],
          [userStartLng, userStartLat],
          [userCompanyLng, userCompanyLat],
          [clickedUser.companyCoordLng, clickedUser.companyCoordLat],
        ]);
      } else if (isViewerAddressSelected || user.role == "DRIVER") {
        setPoints([
          [userStartLng, userStartLat],
          [clickedUser.startCoordLng, clickedUser.startCoordLat],
          [clickedUser.companyCoordLng, clickedUser.companyCoordLat],
          [userCompanyLng, userCompanyLat],
        ]);
      } else {
        setPoints([
          [clickedUser.startCoordLng, clickedUser.startCoordLat],
          [clickedUser.companyCoordLng, clickedUser.companyCoordLat],
        ]);
      }
      viewRoute(viewProps);
    },
    [
      geoJsonUsers,
      selectedUserId,
      companyAddressSelected,
      startAddressSelected,
      mapState,
      mapStateLoaded,
      tempOtherUser,
      tempOtherUserMarkerActive,
    ]
  );

  const enhancedSentUsers = requests.sent.map((request: { toUser: any }) =>
    extendPublicUser(request.toUser!)
  );
  const enhancedReceivedUsers = requests.received.map(
    (request: { fromUser: any }) => extendPublicUser(request.fromUser!)
  );
  const enhancedRecs = recommendations.map(extendPublicUser);
  const enhancedFavs = favorites.map(extendPublicUser);
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
        addMapEvents(newMap, user, setPopupUsers);

        // Initial setting of user and company locations
        if (user.role !== "VIEWER") {
          updateUserLocation(newMap, user.startCoordLng, user.startCoordLat);
          updateCompanyLocation(
            newMap,
            user.companyCoordLng,
            user.companyCoordLat,
            user.role,
            user.id,
            true
          );
        }
        setMapStateLoaded(true);
      });
    }
  }, [mapContainerRef, user]);

  useEffect(() => {
    if (mapState && geoJsonUsers && mapStateLoaded) {
      updateGeoJsonUsers(mapState, geoJsonUsers);
    }
  }, [mapState, geoJsonUsers, mapStateLoaded]);

  // separate use effect for user location rendering
  useEffect(() => {
    if (mapStateLoaded && mapState && user) {
      if (user.role === "VIEWER") {
        updateUserLocation(
          mapState,
          startAddressSelected.center[0],
          startAddressSelected.center[1]
        );
        updateCompanyLocation(
          mapState,
          companyAddressSelected.center[0],
          companyAddressSelected.center[1],
          Role.VIEWER,
          user.id,
          true
        );
      }
      if (otherUser) {
        onViewRouteClick(user, otherUser);
      }
    }
  }, [
    companyAddressSelected,
    mapState,
    mapStateLoaded,
    onViewRouteClick,
    otherUser,
    startAddressSelected,
    user,
  ]);
  useEffect(() => {
    setSelectedUserId(null);
    // Clear other user and related route data when sidebar type changes
    setOtherUser(null);
    if (tempOtherUserMarkerActive && tempOtherUser && mapState) {
      updateCompanyLocation(
        mapState,
        tempOtherUser.companyCoordLng,
        tempOtherUser.companyCoordLat,
        tempOtherUser.role,
        tempOtherUser.id,
        false,
        true
      );
      setTempOtherUserMarkerActive(false);
      setTempOtherUser(null);
    }
    if (mapState) {
      clearDirections(mapState);
    }
  }, [sidebarType, tempOtherUser, tempOtherUserMarkerActive, mapState]);

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
      const isViewerWithValidCoords = user.role === "VIEWER" && 
        isValidCoordinates(startAddressSelected.center[0], startAddressSelected.center[1]) &&
        isValidCoordinates(companyAddressSelected.center[0], companyAddressSelected.center[1]);
        
      const isNonViewerWithValidCoords = user.role !== "VIEWER" &&
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
      
      if (tempOtherUserMarkerActive && tempOtherUser) {
        updateCompanyLocation(
          mapState,
          tempOtherUser.companyCoordLng,
          tempOtherUser.companyCoordLat,
          tempOtherUser.role,
          tempOtherUser.id,
          false,
          true
        );
        setTempOtherUserMarkerActive(false);
        setTempOtherUser(null);
      }
      const viewProps = {
        user,
        otherUser: undefined,
        map: mapState,
        userCoord,
        isMobile
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
    tempOtherUser,
    tempOtherUserMarkerActive,
  ]);
  useSearch({
    value: companyAddress,
    type: "address%2Cpostcode",
    setFunc: setCompanyAddressSuggestions,
  });

  useSearch({
    value: startingAddress,
    type: "address%2Cpostcode",
    setFunc: setStartAddressSuggestions,
  });
  useGetDirections({ points: points, map: mapState! });

  // Create a mobile banner component that will be added to the DOM
  const MobileBanner = () => {
    if (!isMobile) return null;
    
    return (
      <div 
        className="absolute top-0 left-0 right-0 z-[9999] bg-yellow-100 text-black py-1 px-4 text-xs text-center"
        style={{ 
          width: '100%',
          position: 'fixed',
          top: 0,
          zIndex: 9999
        }}
      >
        For the full experience, try using CarpoolNU on desktop
      </div>
    );
  };
  
  if (!user) {
    return <Spinner />;
  }

  const viewerBox = (
    <div className="absolute left-0 top-0 z-10 m-2 flex min-w-[25rem] flex-col rounded-xl bg-white p-4 shadow-lg ">
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
          className="h-8 w-8 "
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
          className="flex-1 "
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
        <ToastProvider
          placement="top-right"
          autoDismiss={true}
          newestOnTop={true}
        >
          <Head>
            <title>CarpoolNU</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
          </Head>
          
          {/* Always render the banner outside of other containers */}
          <MobileBanner />
          
          <div className="m-0 h-full max-h-screen w-full">
            {!isMobile && <Header
              data={{
                sidebarValue: sidebarType,
                setSidebar: setSidebarType,
                disabled: user.status === "INACTIVE" && user.role !== "VIEWER",
              }}
            />}
            <div className={`flex h-[91.5%] overflow-hidden ${isMobile ? 'mt-5' : ''}`}>
            {isMobile && sidebarType === "explore" && (
              <div className={`absolute left-1/2 z-30 -translate-x-1/2 transform ${
                mobileSelectedUserID !== null 
                  ? 'hidden' 
                  : 'top-12'
              }`}>
                <div className="h-1.5 w-16 rounded-full bg-gray-500 shadow-sm"></div>
              </div>
            )}
            <div 
              ref={sidebarRef}
              className={`${isMobile 
                ? `absolute left-0 z-20 w-full overflow-y-auto bg-white shadow-lg transition-all duration-300 rounded-t-3xl border-2 border-black ${
                    mobileSelectedUserID !== null 
                      ? 'bottom-12 h-[320px]' // Short height for single card view
                      : 'top-14  h-[calc(100%-3.5rem)]' // Full height otherwise
                  }`
                : 'relative w-[25rem]'}`}>

                {isMobile && mobileSelectedUserID !== null && (
                    <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50 px-3 py-2">
                      <button
                        onClick={() => handleMobileSidebarExpand()}
                        className="flex items-center text-northeastern-red"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="mr-1">
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
                    onViewRouteClick={onViewRouteClick}
                    onUserSelect={handleUserSelect}
                    selectedUser={selectedUser}
                    mobileSelectedUser={mobileSelectedUserID}
                    handleMobileExpand={handleMobileSidebarExpand}
                  />
                )}
              </div>
              

              {!isMobile && <button
                className="absolute bottom-[150px] right-[8px] z-10 flex h-8 w-8 items-center justify-center rounded-md border-2 border-solid border-gray-300 bg-white shadow-sm hover:bg-gray-200"
                id="fly"
              >
                <RiFocus3Line />
              </button>}
              <div className="relative flex-auto">
                {/* Message Panel */}
                {selectedUser && (
                  <div className=" pointer-events-none absolute inset-0 z-10 h-full w-full">
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
                  className="pointer-events-auto relative  z-0 h-full w-full flex-auto"
                >
                  {user.role === "VIEWER" && viewerBox}
                  {!isMobile && <MapLegend role={user.role} />}
                  {!isMobile && <MapConnectPortal
                    otherUsers={popupUsers}
                    extendUser={extendPublicUser}
                    onViewRouteClick={onViewRouteClick}
                    onViewRequest={handleUserSelect}
                    onClose={() => {
                      setPopupUsers(null);
                    }}
                  />}
                  {user.status === "INACTIVE" && user.role !== "VIEWER" && (
                    <InactiveBlocker />
                  )}
                </div>
                {isMobile && (
            <Header
              data={{
                sidebarValue: sidebarType,
                setSidebar: setSidebarType,
                disabled: user.status === "INACTIVE" && user.role !== "VIEWER",
              }}
              isMobile={true}
            />
          )}
              </div>
              
            </div>
            
          </div>
        </ToastProvider>
      </UserContext.Provider>
    </>
  );
};

export default Home;
