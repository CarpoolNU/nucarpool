import mapboxgl from "mapbox-gl";
import { CarpoolAddress, CarpoolFeature, PublicUser, User } from "../types";
import { trpc } from "../trpc";
import { SetStateAction, useEffect } from "react";
import { toast } from "react-toastify";
import polyline from "@mapbox/polyline";
import { GeoJSON, LineString } from "geojson";
import { StaticImageData } from "next/image";
import DriverStart from "../../../public/driver-start.png";
import RiderStart from "../../../public/rider-start.png";
import DriverEnd from "../../../public/driver-dest.png";
import RiderEnd from "../../../public/rider-dest.png";

const previousMarkers: (mapboxgl.Marker | mapboxgl.Popup)[] = [];
export const clearMarkers = () => {
  previousMarkers.forEach((element) => {
    element.remove();
  });
  previousMarkers.length = 0;
};

export const clearDirections = (map: mapboxgl.Map) => {
  if (map.getLayer("route")) {
    map.removeLayer("route");
  }
  if (map.getSource("route")) {
    map.removeSource("route");
  }
};

const createPopup = (text: string) => {
  const popup = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
  }).setText(text);
  popup.addClassName("custom-marker-popup");
  return popup;
};

const createMarkerEl = (imgData: StaticImageData) => {
  const img = new Image();
  img.src = imgData.src;
  img.width = 32;
  img.height = 42;
  return img;
};
interface ViewRouteProps {
  user: User;
  otherUser: PublicUser | undefined;
  map: mapboxgl.Map;
  userCoord:
    | {
        startLat: number;
        startLng: number;
        endLat: number;
        endLng: number;
      }
    | undefined;
}

// Creates MapBox markers showing user's start address and the start area of the other user.
export const viewRoute = (props: ViewRouteProps) => {
  clearMarkers();
  clearDirections(props.map);
  const redCircle = createMarkerEl(DriverStart);
  const selfStartPopup = createPopup("My Start");
  const selfEndPopup = createPopup("My Dest.");
  const orangeStart = createMarkerEl(RiderStart);
  const redStart = createMarkerEl(redCircle);
  let minLng, minLat, maxLng, maxLat;

  // Validate otherUser coordinates
  if (props.otherUser !== undefined) {
    const otherStartLng = props.otherUser.startCoordLng;
    const otherStartLat = props.otherUser.startCoordLat;
    const otherCompanyLng = props.otherUser.companyCoordLng;
    const otherCompanyLat = props.otherUser.companyCoordLat;
    
    // Check if any otherUser coordinates are NaN
    if (isNaN(otherStartLng) || isNaN(otherStartLat) || isNaN(otherCompanyLng) || isNaN(otherCompanyLat)) {
      return;
    }
    
    const otherRole =
      props.otherUser.role.charAt(0).toUpperCase() +
      props.otherUser.role.slice(1).toLowerCase();

    const otherUserStartPopup = createPopup(`${otherRole} Start`);
    const otherUserStartMarker = new mapboxgl.Marker({
      element: otherRole === "Rider" ? orangeStart : redStart,
    })
      .setLngLat([otherStartLng, otherStartLat])
      .setPopup(otherUserStartPopup)
      .addTo(props.map);

    const otherUserEndPopup = createPopup(`${otherRole} Dest.`);
    otherUserEndPopup
      .setLngLat([otherCompanyLng, otherCompanyLat])
      .addTo(props.map);

    otherUserStartMarker.togglePopup();
    previousMarkers.push(otherUserStartMarker);
    previousMarkers.push(otherUserEndPopup);
    minLng = Math.min(otherStartLng, otherCompanyLng);
    minLat = Math.min(otherStartLat, otherCompanyLat);
    maxLng = Math.max(otherStartLng, otherCompanyLng);
    maxLat = Math.max(otherStartLat, otherCompanyLat);
  }
  
  // Validate userCoord coordinates
  if (props.userCoord !== undefined) {
    const userStartLng = props.userCoord.startLng;
    const userStartLat = props.userCoord.startLat; 
    const userEndLng = props.userCoord.endLng;
    const userEndLat = props.userCoord.endLat;
    
    // Check if any userCoord coordinates are NaN
    if (isNaN(userStartLng) || isNaN(userStartLat) || isNaN(userEndLng) || isNaN(userEndLat)) {
      // If we have no valid coordinates at all, just return
      if (minLng === undefined) {
        return;
      }
    } else {
      selfStartPopup
        .setLngLat([userStartLng, userStartLat])
        .addTo(props.map);

      selfEndPopup
        .setLngLat([userEndLng, userEndLat])
        .addTo(props.map);
      previousMarkers.push(selfStartPopup);
      previousMarkers.push(selfEndPopup);
      
      minLng =
        minLng !== undefined
          ? Math.min(minLng, userStartLng, userEndLng)
          : Math.min(userStartLng, userEndLng);
      minLat =
        minLat !== undefined
          ? Math.min(minLat, userStartLat, userEndLat)
          : Math.min(userStartLat, userEndLat);
      maxLng =
        maxLng !== undefined
          ? Math.max(maxLng, userStartLng, userEndLng)
          : Math.max(userStartLng, userEndLng);
      maxLat =
        maxLat !== undefined
          ? Math.max(maxLat, userStartLat, userEndLat)
          : Math.max(userStartLat, userEndLat);
    }
  }
  
  // Final validation before fitting bounds
  if (
    minLng === undefined ||
    minLat === undefined ||
    maxLng === undefined ||
    maxLat === undefined ||
    isNaN(minLng) ||
    isNaN(minLat) ||
    isNaN(maxLng) ||
    isNaN(maxLat) ||
    !isFinite(minLng) ||
    !isFinite(minLat) ||
    !isFinite(maxLng) ||
    !isFinite(maxLat)
  ) {
    return;
  }

  try {
    props.map.fitBounds(
      [
        [minLng - 0.0075, minLat - 0.0075],
        [maxLng + 0.0075, maxLat + 0.0075],
      ],
      { padding: 20 }
    );
  } catch (error) {
    console.error("Error fitting bounds:", error);
  }
};

export function useGetDirections({
  points,
  map,
}: {
  points: [number, number][];
  map: mapboxgl.Map;
}) {
  const query = trpc.mapbox.getDirections.useQuery(
    {
      points: points,
    },
    {
      onSuccess: (response) => {
        const coordinates = response.routes[0].geometry;

        // Decode the encoded polyline into an array of coordinates
        const decodedCoordinates = polyline.decode(coordinates);

        // Convert the decoded coordinates into GeoJSON format
        const geoJsonCoordinates = decodedCoordinates.map(([lat, lon]) => [
          lon,
          lat,
        ]);

        // Create a GeoJSON LineString feature
        const lineStringFeature: GeoJSON.Feature<
          GeoJSON.LineString,
          GeoJSON.GeoJsonProperties
        > = {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: geoJsonCoordinates,
          },
          properties: {},
        };

        if (map.getLayer("route")) {
          const source = map.getSource("route") as mapboxgl.GeoJSONSource;
          source.setData(lineStringFeature);
        } else {
          let beforeLayerId = "";
          if (map.getLayer("layer-with-pulsing-dot")) {
            beforeLayerId = "layer-with-pulsing-dot";
          } else if (map.getLayer("riders")) {
            beforeLayerId = "riders";
          } else if (map.getLayer("drivers")) {
            beforeLayerId = "drivers";
          }

          map.addLayer(
            {
              id: "route",
              type: "line",
              source: {
                type: "geojson",
                data: lineStringFeature,
              },
              layout: {
                "line-join": "round",
                "line-cap": "round",
              },
              paint: {
                "line-color": "#4a89f3 ",
                "line-width": 6,
              },
            },
            beforeLayerId
          );
        }
      },
      onError: (error) => {
        toast.error(`Something went wrong: ${error}`);
      },
      enabled: false,
      retry: false,
    }
  );
  useEffect(() => {
    // ensures that we don't run on page load
    if (points.length !== 0 && map !== undefined) {
      query.refetch();
    }
  }, [points, map, query]);
}
