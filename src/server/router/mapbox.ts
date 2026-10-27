import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedRouter, router } from "./createRouter";
import { Feature, FeatureCollection } from "geojson";
import { serverEnv } from "../../utils/env/server";
import { Location, Role } from "@prisma/client";
import { DirectionsResponse } from "../../utils/types";
import { convertCarpoolSearchToPublic, roundCoord } from "../publicUser";
import {
  candidateExclusions,
  fetchRankedCandidates,
} from "../db/candidateSearch";
import { parseMapboxFeature } from "../../utils/map/parseAddress";
import {
  MAPBOX_DIRECTIONS_MAX_POINTS,
  MAPBOX_DIRECTIONS_MIN_POINTS,
  MAPBOX_SEARCH_MAX_LENGTH,
  MAPBOX_SEARCH_TYPES,
  buildDirectionsUrl,
  buildGeocodingSearchUrl,
} from "../../utils/map/mapboxUrls";
import {
  isUnresolvedCoordinate,
  latitudeSchema,
  longitudeSchema,
} from "../../utils/coordinates";
import { NEU_LAT, NEU_LNG } from "../../utils/map/mapHomeCentre";

/**
 * Points the map returns for a matchable user.
 */
export const MAP_RESULT_LIMIT = 150;

/**
 * How many ranked points a reader receives — the same number for every role.
 *
 * **A VIEWER used to be exempt, and the exemption was right at the time.** The
 * map sorts by `sort: "distance"`, that score is `startDistance + endDistance`
 * measured from the *reader's own* stored coordinates, and a VIEWER is allowed
 * to have none: both address fields are optional for them in `onboardSchema`,
 * `unresolvedAddressFields` exempts them explicitly, and `(0, 0)` is what
 * `user.me` reports for a row with no real `Location`. Ranking a VIEWER's
 * candidates by distance from a point in the Gulf of Guinea orders the set
 * without saying anything about relevance, so there was no meaningful
 * "nearest 150" to take and slicing would have returned an arbitrary 150.
 *
 * `viewerReferenceSearch` below removes that blocker by giving a VIEWER a
 * reference point that means something, which is what lets the cap apply to
 * everyone.
 *
 * **The cap and the reference point are one decision, not two.** Reinstating
 * the exemption while the reference point stays leaves a VIEWER receiving every
 * matchable profile on the platform again — bulk disclosure of name, pronouns,
 * bio, "City, State" home, coarsened home coordinates and the employer's street
 * address, growing with the platform until it meets `CANDIDATE_LIMIT`, which is
 * what SCRUM-642 was filed for. Dropping the reference point while this cap is
 * unconditional silently reintroduces the arbitrary slice. Either half alone is
 * a defect; change them together or not at all.
 */
export const limitMapResults = <T>(searches: T[]): T[] =>
  searches.slice(0, MAP_RESULT_LIMIT);

/**
 * A point the client says a VIEWER is browsing around.
 *
 * Named components rather than a tuple: `[lng, lat]` is Mapbox's order and
 * `[lat, lng]` is everyone else's, and the two are indistinguishable on the
 * wire at Boston's latitude only until one of them is wrong.
 */
const referencePointSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});

export type ReferencePoint = z.infer<typeof referencePointSchema>;

/**
 * Which point a VIEWER's ranking was taken from. Returned alongside the
 * coordinates so the fallback is a stated outcome rather than something a
 * reader has to recognise by its latitude.
 */
export type ViewerReferenceSource = "picked" | "campus";

/**
 * The point to rank a VIEWER's candidates around, and where it came from.
 *
 * **The address they picked when there is one, campus otherwise — never
 * `(0, 0)`.** Campus is not an arbitrary default: `mapHomeCentre` already opens
 * a VIEWER's map on `NEU_CENTRE` and flies the recentre button back to it, so
 * falling back there makes "the nearest `MAP_RESULT_LIMIT`" mean "nearest to
 * what this user is actually looking at". Any other fallback would bound the
 * response around one place while the map showed another, which is the failure
 * the old exemption existed to avoid.
 *
 * The sentinel is re-checked here rather than trusted to the client. `(0, 0)`
 * is inside the valid WGS 84 range, so `referencePointSchema` accepts it, and
 * it is exactly what `useAddressSelection` holds before an address is picked —
 * so the one value most likely to arrive is the one that must not be ranked
 * around.
 */
export const viewerReferencePoint = (
  picked: ReferencePoint | undefined,
): { coordLat: number; coordLng: number; source: ViewerReferenceSource } =>
  picked && !isUnresolvedCoordinate(picked.lng, picked.lat)
    ? { coordLat: picked.lat, coordLng: picked.lng, source: "picked" }
    : { coordLat: NEU_LAT, coordLng: NEU_LNG, source: "campus" };

/**
 * A `Location` carrying the reference coordinates and nothing else of substance.
 *
 * In memory only, never written. It exists so the reference point can reach
 * `calculateScore` and `buildCandidateWhere` through the field they both
 * already read, instead of threading a second centre through every caller of
 * `fetchRankedCandidates` — which `user.recommendations.me` shares and this
 * ticket must not disturb.
 *
 * The address columns are blank and the timestamps are the epoch, and the
 * reader's stored row is **not** carried over even when they have one. Only
 * `coordLat` and `coordLng` are read for the reader's own search —
 * `convertCarpoolSearchToPublic` is applied to candidates, not to this row — so
 * keeping the rest would pair a real street address with coordinates somewhere
 * else entirely. A row that contradicts itself is worse than a blank one: it
 * is the kind of fixture that later gets believed.
 */
const referenceLocation = (point: {
  coordLat: number;
  coordLng: number;
}): Location => ({
  id: "",
  city: "",
  state: "",
  street: "",
  streetAddress: "",
  dateCreated: new Date(0),
  dateModified: new Date(0),
  coordLat: point.coordLat,
  coordLng: point.coordLng,
});

/**
 * The reader's own search as the ranking should see it.
 *
 * For every role but VIEWER this returns the row itself, by identity — the
 * substituted copy is built only on the VIEWER branch, so a DRIVER or RIDER
 * reaches `fetchRankedCandidates` with the same object it received before.
 *
 * **What this changes beyond the ranking.** The substituted coordinates also
 * reach `buildCandidateWhere`, which derives its bounding box from these same
 * two fields. That is deliberate rather than incidental: the box and the
 * scorer's cutoff have to agree on where the centre is, and the superset rule
 * `candidateSearch.ts` is written to holds by construction only when they read
 * one value. It also settles a second-order effect of the old sentinel — a
 * VIEWER who moved a distance slider off "any" was scored against `(0, 0)`,
 * putting every candidate some 4,000 miles away and past every cutoff, so the
 * map came back empty.
 *
 * **It is a privacy trade, and it is the ticket's.** A VIEWER's picked
 * addresses previously never left the browser; bounding the response means the
 * server learns the two points they are browsing between. SCRUM-642 weighed
 * that against shipping every matchable profile to the least-verified role on
 * the platform and chose this. The points rank the query and are not stored.
 */
export const viewerReferenceSearch = <
  T extends {
    role: Role;
    homeLocation: Location | null;
    companyLocation: Location | null;
  },
>(
  currentUserSearch: T,
  input: { viewerStart?: ReferencePoint; viewerCompany?: ReferencePoint },
): T => {
  if (currentUserSearch.role !== Role.VIEWER) {
    return currentUserSearch;
  }

  return {
    ...currentUserSearch,
    homeLocation: referenceLocation(viewerReferencePoint(input.viewerStart)),
    companyLocation: referenceLocation(
      viewerReferencePoint(input.viewerCompany),
    ),
  };
};

// router for interacting with the Mapbox API
export const mapboxRouter = router({
  /**
   * Address autocomplete, proxied so the Mapbox token stays server-side.
   *
   * The input is deliberately narrow: the caller chooses the
   * search text and which of two categories to search, and nothing else.
   * `autocomplete`, `country`, `proximity` and `types` are fixed server-side
   * in `buildGeocodingSearchUrl`, so the client cannot control any other part
   * of the upstream URL our server issues.
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

      // Without this check, a non-2xx response falls through to
      // `data.features.map`, which throws a TypeError on the error body
      // instead of surfacing the actual failure.
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
        days: z.number(), // 0 any, 1 exact, 2 flex
        daysWorking: z.string(),
        flexDays: z.number(),
        startDistance: z.number(), // miles, 0-20; 20 means any
        endDistance: z.number(),
        startTime: z.number(), // hours of deviation, 0-4; 4 means any (a maximum)
        endTime: z.number(),
        startDate: z.date(),
        endDate: z.date(),
        dateOverlap: z.number(), // 0 any, 1 partial, 2 full
        favorites: z.boolean(), // if true, only show users user has favorited
        messaged: z.boolean(), // if false, hide users user has messaged
        // The two points a VIEWER picked in the route-search panel. Optional
        // and ignored for every other role, whose reference point is their own
        // stored `Location` — see `viewerReferenceSearch`, which is also where
        // the privacy trade these represent is recorded. A VIEWER who has
        // picked nothing sends neither and is ranked around campus.
        viewerStart: referencePointSchema.optional(),
        viewerCompany: referencePointSchema.optional(),
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

      // The reader, anyone with a block either way, and - when the filter
      // asks - anyone they have messaged. Shared with
      // `user.recommendations.me`.
      const excludedUserIds = await candidateExclusions({
        prisma: ctx.prisma,
        userId,
        messaged: input.messaged,
        sentRequests,
        receivedRequests,
      });

      // A VIEWER has no stored coordinates to rank against, so the points they
      // picked in the browser stand in — campus if they have picked none.
      // Every other role gets `currentUserSearch` back unchanged, by identity.
      const rankingSearch = viewerReferenceSearch(currentUserSearch, input);

      // Bounded candidate query plus scoring, shared with
      // `user.recommendations.me`.
      const sortedSearches = await fetchRankedCandidates({
        prisma: ctx.prisma,
        currentUserSearch: rankingSearch,
        filters: input,
        sort: "distance",
        excludedUserIds,
        // Guarded for the same reason as the `sentRequests` branch above: the
        // `favorites` include is `input.favorites`, and Prisma omits the key
        // rather than returning [] when an include is false.
        favoriteUserIds: input.favorites ? favorites.map((f) => f.id) : [],
      });

      const finalSearches = limitMapResults(sortedSearches);

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
        // forwarded. The bounds live in `utils/coordinates.ts`, shared with
        // `user.edit`.
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
