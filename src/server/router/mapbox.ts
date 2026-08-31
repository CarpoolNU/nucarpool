import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "./createRouter";
import { Feature, FeatureCollection } from "geojson";
import { serverEnv } from "../../utils/env/server";
import { Role } from "@prisma/client";
import { DirectionsResponse } from "../../utils/types";
import {
  convertCarpoolSearchToPublic,
  roundCoord,
} from "../../utils/publicUser";
import { fetchRankedCandidates } from "../db/candidateSearch";
import { parseMapboxFeature } from "../../utils/map/parseAddress";
import {
  MAPBOX_DIRECTIONS_MAX_POINTS,
  MAPBOX_DIRECTIONS_MIN_POINTS,
  MAPBOX_SEARCH_MAX_LENGTH,
  MAPBOX_SEARCH_TYPES,
  buildDirectionsUrl,
  buildGeocodingSearchUrl,
} from "../../utils/map/mapboxUrls";
import { latitudeSchema, longitudeSchema } from "../../utils/coordinates";

/**
 * Points the map returns for a matchable user. A VIEWER is not matchable and
 * gets the whole ranked set, which is pre-existing behaviour.
 */
const MAP_RESULT_LIMIT = 150;

// router for interacting with the Mapbox API
export const mapboxRouter = router({
  /**
   * Address autocomplete, proxied so the Mapbox token stays server-side.
   *
   * The input is deliberately narrow (SCRUM-244): the caller chooses the
   * search text and which of two categories to search, and nothing else.
   * `autocomplete`, `country` and `proximity` used to be sent by the client
   * and interpolated straight into the upstream URL, along with a
   * pre-encoded `types` string, which meant the client controlled part of a
   * URL our server issues. They are fixed in buildGeocodingSearchUrl now.
   */
  search: protectedRouter
    .input(
      z.object({
        value: z.string().trim().min(1).max(MAPBOX_SEARCH_MAX_LENGTH),
        types: z.enum(
          Object.keys(MAPBOX_SEARCH_TYPES) as [
            keyof typeof MAPBOX_SEARCH_TYPES,
            ...(keyof typeof MAPBOX_SEARCH_TYPES)[],
          ],
        ),
      }),
    )
    .query(async ({ input }): Promise<FeatureCollection> => {
      const endpoint = buildGeocodingSearchUrl({
        value: input.value,
        type: input.types,
        accessToken: serverEnv.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
      });

      const response = await fetch(endpoint).catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected error. Please try again.",
          cause: err,
        });
      });

      // A non-2xx from Mapbox used to fall through to `data.features.map`,
      // which threw a TypeError on the error body rather than surfacing the
      // failure.
      if (!response.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected error. Please try again.",
          cause: new Error(`Mapbox geocoding responded ${response.status}`),
        });
      }

      const data = await response.json().catch((err) => {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected error. Please try again.",
          cause: err,
        });
      });

      if (!Array.isArray(data?.features)) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unexpected error. Please try again.",
          cause: new Error("Mapbox geocoding response had no features array"),
        });
      }

      // parse features to include structured address components
      const parsedFeatures = data.features.map((feature: any) =>
        parseMapboxFeature(feature),
      );

      return {
        ...data,
        features: parsedFeatures,
      };
    }),

  //queries all other users and locations besides current user
  geoJsonUserList: protectedRouter
    .input(
      z.object({
        days: z.number(), /// 0 for any, 1 for exact
        daysWorking: z.string(),
        flexDays: z.number(),
        startDistance: z.number(), // max 20, greater = any
        endDistance: z.number(),
        startTime: z.number(), // max = 4 hours, greater = any
        endTime: z.number(),
        startDate: z.date(),
        endDate: z.date(),
        dateOverlap: z.number(), // 0 any, 1 partial, 2 full
        favorites: z.boolean(), // if true, only show users user has favorited
        messaged: z.boolean(), // if false, hide users user has messaged
      }),
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user?.id;

      if (!userId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "User not authenticated.",
        });
      }

      const currentUserSearch = await ctx.prisma.carpoolSearch.findFirst({
        where: { userId },
        include: {
          user: {
            include: {
              favorites: input.favorites,
              sentRequests: !input.messaged,
              receivedRequests: !input.messaged,
            },
          },
          homeLocation: true,
          companyLocation: true,
        },
      });

      if (!currentUserSearch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No carpool search found for user ${userId}.`,
        });
      }

      const { favorites, sentRequests, receivedRequests } =
        currentUserSearch.user;

      let excludedUserIds: string[] = [userId];

      // Hide users user has messaged
      if (!input.messaged) {
        excludedUserIds.push(
          ...sentRequests.map((r) => r.toUserId),
          ...receivedRequests.map((r) => r.fromUserId),
        );
      }

      // Bounded candidate query plus scoring, shared with
      // `user.recommendations.me` (SCRUM-245). The two used to hold separate
      // copies of this, each reading every ACTIVE row.
      const sortedSearches = await fetchRankedCandidates({
        prisma: ctx.prisma,
        currentUserSearch,
        filters: input,
        sort: "distance",
        excludedUserIds,
        // Guarded for the same reason as the `sentRequests` branch above: the
        // `favorites` include is `input.favorites`, and Prisma omits the key
        // rather than returning [] when an include is false (SCRUM-288).
        favoriteUserIds: input.favorites ? favorites.map((f) => f.id) : [],
      });

      const finalSearches =
        currentUserSearch.role === Role.VIEWER
          ? sortedSearches
          : sortedSearches.slice(0, MAP_RESULT_LIMIT);

      const finalPublicUsers = finalSearches.map(convertCarpoolSearchToPublic);

      // creates points for each user with coordinates at company location
      const features: Feature[] = finalPublicUsers.map((u) => {
        return {
          type: "Feature" as "Feature",
          geometry: {
            type: "Point" as "Point",
            coordinates: [
              roundCoord(u.companyCoordLng),
              roundCoord(u.companyCoordLat),
            ],
          },
          properties: {
            ...u,
          },
        };
      });

      const featureCollection: FeatureCollection = {
        type: "FeatureCollection" as "FeatureCollection",
        features,
      };

      return featureCollection;
    }),

  getDirections: protectedRouter
    .input(
      z.object({
        // Array of tuples containing longitude and latitude. Bounded so a
        // single call cannot ask Mapbox for an arbitrarily long route, and
        // range-checked so nonsense coordinates are rejected here rather than
        // forwarded (SCRUM-244). The bounds moved to `utils/coordinates.ts` when
        // `user.edit` needed the same ones (SCRUM-302).
        points: z
          .array(z.tuple([longitudeSchema, latitudeSchema]))
          .min(MAPBOX_DIRECTIONS_MIN_POINTS)
          .max(MAPBOX_DIRECTIONS_MAX_POINTS),
      }),
    )
    .query(async ({ input }): Promise<DirectionsResponse> => {
      const endpoint = buildDirectionsUrl({
        points: input.points,
        accessToken: serverEnv.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN,
      });
      const data = await fetch(endpoint)
        .then((response) => response.json())
        .then((json) => {
          if (json.code != "Ok") {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: json.message,
              cause: json,
            });
          } else {
            return json;
          }
        })
        .catch((err) => {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Unexpected error. Please try again.",
            cause: err,
          });
        });
      return data;
    }),
});
