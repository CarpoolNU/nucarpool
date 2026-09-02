import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "./createRouter";
import { Feature, FeatureCollection } from "geojson";
import { serverEnv } from "../../utils/env/server";
import { Role } from "@prisma/client";
import { DirectionsResponse } from "../../utils/types";
import { convertCarpoolSearchToPublic, roundCoord } from "../publicUser";
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
 * Points the map returns for a matchable user.
 */
export const MAP_RESULT_LIMIT = 150;

/**
 * How many ranked points a reader receives, by role.
 *
 * A VIEWER is exempt from `MAP_RESULT_LIMIT`, and the comment here used to say
 * only that this was "pre-existing behaviour" — which read as an oversight
 * nobody had chosen. SCRUM-346 asked whether it was intended. It is, for a
 * reason worth writing down, because the obvious tidy-up of treating every role
 * alike would quietly break VIEWER browsing.
 *
 * **The server cannot rank for a VIEWER, so there is no meaningful "top 150" to
 * take.** The map sorts by `sort: "distance"`, and that score is
 * `startDistance + endDistance` measured from the *reader's own* stored
 * coordinates. A VIEWER is allowed not to have any: both address fields are
 * optional for them in `onboardSchema`, `unresolvedAddressFields` exempts them
 * explicitly, and `(0, 0)` is what `user.me` reports for a row with no real
 * `Location`. In staging, 9 of 14 active VIEWERs sit at exactly that sentinel.
 * For them every candidate is ranked by its distance from a point in the
 * Atlantic, which orders the set without saying anything about relevance.
 *
 * The geography a VIEWER actually browses by is chosen in the browser and never
 * reaches us: `index.tsx` requires a VIEWER to pick a start and a company
 * address before it will draw anything, and re-centres on those picks rather
 * than on anything stored. So slicing server-side would hand the client an
 * arbitrary 150 and a VIEWER who then picked an address across town could find
 * the map empty of anyone near it.
 *
 * The cost is a larger payload, and it is not free: a VIEWER receives about 751
 * `PublicUser` records where every other role receives 150 — roughly 5x — and
 * that grows with the platform until it meets `CANDIDATE_LIMIT` (SCRUM-345).
 * Each record carries a name, pronouns, bio, "City, State" home, coarsened home
 * coordinates and the employer's street address. It no longer carries an email
 * address; SCRUM-292 removed that. With 13 active onboarded VIEWERs the
 * exposure is small today, which is what makes this a decision to revisit
 * rather than an incident.
 *
 * Bounding a VIEWER properly means giving them a ranking that means something —
 * sending the address they picked so the server can sort around it, or ranking
 * in SQL — and both are larger than this ticket.
 */
export const limitMapResults = <T>(searches: T[], role: Role): T[] =>
  role === Role.VIEWER ? searches : searches.slice(0, MAP_RESULT_LIMIT);

// router for interacting with the Mapbox API
export const mapboxRouter = router({
  /**
   * Address autocomplete, proxied so the Mapbox token stays server-side.
   *
   * The input is deliberately narrow: the caller chooses the
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
      // `user.recommendations.me`. The two used to hold separate
      // copies of this, each reading every ACTIVE row.
      const sortedSearches = await fetchRankedCandidates({
        prisma: ctx.prisma,
        currentUserSearch,
        filters: input,
        sort: "distance",
        excludedUserIds,
        // Guarded for the same reason as the `sentRequests` branch above: the
        // `favorites` include is `input.favorites`, and Prisma omits the key
        // rather than returning [] when an include is false.
        favoriteUserIds: input.favorites ? favorites.map((f) => f.id) : [],
      });

      const finalSearches = limitMapResults(
        sortedSearches,
        currentUserSearch.role,
      );

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
        // forwarded. The bounds moved to `utils/coordinates.ts` when
        // `user.edit` needed the same ones.
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
