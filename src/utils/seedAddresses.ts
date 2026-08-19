/**
 * Address generation for `prisma/seed.ts`.
 *
 * The seed needs a street/city/state for two locations per user. It used to call
 * Mapbox reverse geocoding for every one of them — roughly 140 requests per seed,
 * against a shared API quota, on a script whose whole purpose is throwaway local
 * data. Worse, without `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN` every one of those calls
 * failed and fell back to the same hardcoded "123 Main St, Boston, MA", so all 70
 * users ended up at one address.
 *
 * Addresses are therefore synthesised offline by default: deterministic, varied,
 * instant, and free. Real reverse geocoding is still available by setting
 * SEED_REVERSE_GEOCODE=1, in which case results are cached per coordinate.
 *
 * This module is tooling for the seed script, not application code.
 */

/** Set to "1" or "true" to reverse geocode against Mapbox instead of synthesising. */
export const SEED_GEOCODE_ENV = "SEED_REVERSE_GEOCODE";

export type SeedAddress = {
  street: string;
  city: string;
  state: string;
  address: string;
};

/**
 * Shape of the Mapbox geocoding features this code reads. Only the fields used
 * are declared; the API returns considerably more.
 */
export type MapboxFeature = {
  place_type?: string[];
  text?: string;
};

/** Plausible Boston-area values. The seed's coordinates are all around Boston. */
const STREETS = [
  "Beacon St",
  "Boylston St",
  "Huntington Ave",
  "Commonwealth Ave",
  "Massachusetts Ave",
  "Tremont St",
  "Columbus Ave",
  "Harvard St",
  "Washington St",
  "Summer St",
];

const CITIES = [
  "Boston",
  "Cambridge",
  "Brookline",
  "Somerville",
  "Medford",
  "Quincy",
  "Newton",
  "Malden",
];

const STATE = "MA";

/**
 * FNV-1a over the coordinate at fixed precision. Any stable hash would do; the
 * requirement is only that the same coordinate always yields the same address,
 * so re-seeding is reproducible and location de-duplication behaves consistently.
 */
function hashCoordinate(lng: number, lat: number): number {
  const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // >>> 0 keeps this an unsigned 32-bit multiply rather than drifting into
    // floating point, which would make the hash platform-sensitive.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A deterministic, offline, plausible address for a coordinate. */
export function synthesizeAddress(lng: number, lat: number): SeedAddress {
  const hash = hashCoordinate(lng, lat);
  const street = `${(hash % 400) + 1} ${STREETS[hash % STREETS.length]}`;
  const city = CITIES[Math.floor(hash / STREETS.length) % CITIES.length];
  return {
    street,
    city,
    state: STATE,
    address: `${street}, ${city}, ${STATE}`,
  };
}

/** True only for an explicit opt-in value. */
export function isRealGeocodingEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/**
 * Extracts street, city and state from Mapbox geocoding features.
 *
 * Preserved from the original inline implementation, including its quirks: the
 * building number is split off the `address` feature's text when the first token
 * is numeric, and a point of interest supplies the display address when present.
 * Extracted so it can be tested without issuing a request.
 */
export function parseMapboxFeatures(features: MapboxFeature[]): SeedAddress {
  let street = "";
  let city = "";
  let state = "";
  let address = "";
  let buildingNumber = "";

  for (const feature of features) {
    const placeTypes = feature.place_type ?? [];
    const text = feature.text ?? "";

    if (placeTypes.includes("address")) {
      const addressParts = text.split(" ");
      if (
        addressParts.length > 0 &&
        addressParts[0] !== "" &&
        !isNaN(Number(addressParts[0]))
      ) {
        buildingNumber = addressParts[0];
        street = addressParts.slice(1).join(" ");
      } else {
        street = text;
      }
    }

    if (placeTypes.includes("place") && !city) {
      city = text;
    }

    if (placeTypes.includes("region") && !state) {
      state = text;
    }

    if (placeTypes.includes("poi") && !address) {
      address = text;
    }
  }

  if (buildingNumber && street) {
    street = `${buildingNumber} ${street}`;
  }

  if (!address) {
    address = `${street}, ${city}, ${state}`;
  }

  return { street, city, state, address };
}

export type AddressResolver = (
  lng: number,
  lat: number,
) => Promise<SeedAddress>;

type ResolverOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  onNotice?: (message: string) => void;
};

/**
 * Builds the resolver the seed uses.
 *
 * Offline synthesis unless SEED_REVERSE_GEOCODE opts in and a Mapbox token is
 * present. When geocoding is live, identical coordinates are resolved once and
 * cached, and any failure degrades to synthesis rather than to a single shared
 * fallback address.
 */
export function createAddressResolver(
  options: ResolverOptions = {},
): AddressResolver {
  const env = options.env ?? process.env;
  const notify =
    options.onNotice ?? ((message: string) => console.log(message));
  const token = env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;
  const wantsGeocoding = isRealGeocodingEnabled(env[SEED_GEOCODE_ENV]);

  if (!wantsGeocoding) {
    notify(
      `Synthesising addresses offline. Set ${SEED_GEOCODE_ENV}=1 to reverse geocode with Mapbox instead (consumes API quota).`,
    );
    return async (lng, lat) => synthesizeAddress(lng, lat);
  }

  if (!token) {
    notify(
      `${SEED_GEOCODE_ENV} is set but NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN is not. Synthesising addresses offline instead.`,
    );
    return async (lng, lat) => synthesizeAddress(lng, lat);
  }

  const doFetch = options.fetchImpl ?? fetch;
  const cache = new Map<string, Promise<SeedAddress>>();
  notify(
    `${SEED_GEOCODE_ENV} is set. Reverse geocoding with Mapbox; this consumes API quota.`,
  );

  return (lng, lat) => {
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = (async (): Promise<SeedAddress> => {
      try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}&types=address,place,locality,region`;
        const response = await doFetch(url);
        if (!response.ok) {
          throw new Error(`Mapbox responded ${response.status}`);
        }
        const data: { features?: MapboxFeature[] } = await response.json();
        return parseMapboxFeatures(data.features ?? []);
      } catch (error) {
        // Synthesise rather than reuse one hardcoded address, so a partial
        // outage does not collapse every user onto the same street.
        console.error(
          `Reverse geocoding failed for ${key}; synthesising instead:`,
          error,
        );
        return synthesizeAddress(lng, lat);
      }
    })();

    cache.set(key, pending);
    return pending;
  };
}
