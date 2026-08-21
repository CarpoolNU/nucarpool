/**
 * Mapbox request URLs (SCRUM-244).
 *
 * `mapbox.search` used to build its upstream URL by string concatenation with
 * the user's raw search text spliced into the path:
 *
 *     `https://api.mapbox.com/geocoding/v5/mapbox.places/${input.value}.json?access_token=...&types=${input.types}`
 *
 * `input.value` was an unconstrained `z.string()`, so a `?`, `&` or `#` in the
 * search text changed the request rather than being searched for — a caller
 * could append or override parameters we intended to fix, and an encoded `/`
 * could walk out of `/geocoding/v5/mapbox.places/` to another endpoint on the
 * same host. It also broke legitimate searches: nobody could look up an
 * address containing an ampersand.
 *
 * These builders are the single place a Mapbox URL is assembled. They take the
 * access token as an argument rather than reading `serverEnv`, so they carry no
 * import-time environment dependency and can be tested directly.
 */

/**
 * The forward-geocoding categories the app exposes, keyed by the name the
 * client sends. The Mapbox-facing value is chosen here rather than accepted
 * from the client, which previously passed the pre-encoded string through.
 */
export const MAPBOX_SEARCH_TYPES = {
  address: "address,postcode",
  place: "neighborhood,place",
} as const;

export type MapboxSearchType = keyof typeof MAPBOX_SEARCH_TYPES;

/**
 * Mapbox rejects a forward-geocoding query longer than 256 characters, so
 * there is no point forwarding one.
 */
export const MAPBOX_SEARCH_MAX_LENGTH = 256;

/**
 * Mapbox allows 25 coordinates on the driving profile. The app's own worst
 * case is smaller — a full carpool is one driver plus MAX_SEATS_AVAILABLE (6)
 * riders, and a route is start + pickup and dropoff per rider + destination,
 * so 14 — but the upstream limit is the honest bound to enforce.
 */
export const MAPBOX_DIRECTIONS_MAX_POINTS = 25;
/** A route needs somewhere to start and somewhere to finish. */
export const MAPBOX_DIRECTIONS_MIN_POINTS = 2;

const GEOCODING_BASE = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const DIRECTIONS_BASE = "https://api.mapbox.com/directions/v5/mapbox/driving";

/**
 * Forward-geocoding URL for a user's search text.
 *
 * `value` is the only part a caller influences and it is percent-encoded, so
 * every character in it reaches Mapbox as search text rather than as URL
 * syntax. Everything else is fixed here.
 */
export const buildGeocodingSearchUrl = ({
  value,
  type,
  accessToken,
}: {
  value: string;
  type: MapboxSearchType;
  accessToken: string;
}): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Mapbox search value must not be empty");
  }
  if (trimmed.length > MAPBOX_SEARCH_MAX_LENGTH) {
    throw new Error(
      `Mapbox search value must be at most ${MAPBOX_SEARCH_MAX_LENGTH} characters`,
    );
  }

  const url = new URL(`${GEOCODING_BASE}/${encodeURIComponent(trimmed)}.json`);
  url.search = new URLSearchParams({
    access_token: accessToken,
    autocomplete: "true",
    country: "us",
    proximity: "ip",
    types: MAPBOX_SEARCH_TYPES[type],
  }).toString();

  return url.toString();
};

/**
 * Directions URL for an ordered list of waypoints.
 *
 * Coordinates go into the path unencoded because Mapbox requires the literal
 * `,` and `;` separators. That is only safe while every value is a finite
 * number in range, so this asserts it rather than trusting the caller — the
 * Zod schema on the procedure checks the same thing, and these must not
 * disagree.
 */
export const buildDirectionsUrl = ({
  points,
  accessToken,
}: {
  points: readonly (readonly [number, number])[];
  accessToken: string;
}): string => {
  if (
    points.length < MAPBOX_DIRECTIONS_MIN_POINTS ||
    points.length > MAPBOX_DIRECTIONS_MAX_POINTS
  ) {
    throw new Error(
      `Mapbox directions needs between ${MAPBOX_DIRECTIONS_MIN_POINTS} and ` +
        `${MAPBOX_DIRECTIONS_MAX_POINTS} points, got ${points.length}`,
    );
  }

  const coordinates = points
    .map(([lng, lat]) => {
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new Error(`Longitude out of range: ${lng}`);
      }
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new Error(`Latitude out of range: ${lat}`);
      }
      return `${lng},${lat}`;
    })
    .join(";");

  const url = new URL(`${DIRECTIONS_BASE}/${coordinates}`);
  url.search = new URLSearchParams({ access_token: accessToken }).toString();

  return url.toString();
};
