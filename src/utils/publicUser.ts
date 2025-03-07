import { User } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { serverEnv } from "./env/server";
import { PublicUser, PoiData } from "./types";

/**
 * Converts the given ``User`` to a ``PublicUser``, as to hide sensitive data.
 *
 * @param user a rider or driver.
 * @returns non-sensitive information about a user.
 */
export const convertToPublic = (user: User): PublicUser => {
  const cleanAddressForPublicView = (address: string) => {
    const startAddressAsList = user.startAddress.split(', ');
    const cleanedAddress = startAddressAsList.length === 4 ? startAddressAsList[1] : startAddressAsList.length === 3 ? startAddressAsList[0] : "Exact Location Unavailable";
    return cleanedAddress;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    bio: user.bio,
    preferredName: user.preferredName,
    pronouns: user.pronouns,
    role: user.role,
    status: user.status,
    seatAvail: user.seatAvail,
    companyName: user.companyName,
    daysWorking: user.daysWorking,
    startTime: user.startTime,
    endTime: user.endTime,
    coopEndDate: user.coopEndDate,
    coopStartDate: user.coopStartDate,
    startAddress: cleanAddressForPublicView(user.startAddress),
    startCoordLng: user.startCoordLng,
    startCoordLat: user.startCoordLat,
    companyAddress: user.companyAddress,
    companyCoordLng: user.companyCoordLng,
    companyCoordLat: user.companyCoordLat,
    carpoolId: user.carpoolId,
  };
};

export const roundCoord = (coord: number) => {
  return Math.round((coord + Number.EPSILON) * 100000) / 100000;
};

/**
 * Generates place of interest data given a point on the map.
 *
 * @param longitude the geographical longitude.
 * @param latitude the geographical latitude.
 * @returns non-specific location information (AKA POI).
 */
export const generatePoiData = async (
  longitude: number,
  latitude: number
): Promise<PoiData> => {
  const endpoint = [
    "https://api.mapbox.com/geocoding/v5/mapbox.places/",
    longitude,
    ", ",
    latitude,
    ".json?types=poi&access_token=",
    serverEnv.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
  ].join("");
  const data = await fetch(endpoint)
    .then((response) => response.json())
    .catch((err) => {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unexpected error. Please try again.",
        cause: err,
      });
    });

  return {
    location: data.features[0]?.text || "NOT FOUND",
    coordLng: data.features[0]?.center[0] ?? -999,
    coordLat: data.features[0]?.center[1] ?? -999,
  };
};
