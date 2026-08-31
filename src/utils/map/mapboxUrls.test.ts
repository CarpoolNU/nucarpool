import {
  MAPBOX_DIRECTIONS_MAX_POINTS,
  MAPBOX_SEARCH_MAX_LENGTH,
  buildDirectionsUrl,
  buildGeocodingSearchUrl,
} from "./mapboxUrls";

/**
 * URL construction for the Mapbox proxy procedures.
 *
 * The previous implementation concatenated the user's raw search text into the
 * upstream path. These tests are written as assertions about the *parsed*
 * URL — pathname and searchParams — rather than about string contents, because
 * that is the only way to show that hostile text ends up as data rather than
 * as URL syntax. A substring check would pass on a URL whose query string the
 * caller had rewritten.
 *
 * No network: these build strings, they do not fetch. Nothing here consumes
 * Mapbox quota.
 */

const TOKEN = "pk.test-token-not-real";
const GEOCODING_PREFIX = "/geocoding/v5/mapbox.places/";

const search = (value: string) =>
  new URL(
    buildGeocodingSearchUrl({ value, type: "address", accessToken: TOKEN }),
  );

/** Exactly the parameters the procedure intends to send, and nothing else. */
const expectFixedSearchParams = (url: URL) => {
  expect([...url.searchParams.keys()].sort()).toEqual([
    "access_token",
    "autocomplete",
    "country",
    "proximity",
    "types",
  ]);
  expect(url.searchParams.get("access_token")).toBe(TOKEN);
  expect(url.searchParams.get("autocomplete")).toBe("true");
  expect(url.searchParams.get("country")).toBe("us");
  expect(url.searchParams.get("proximity")).toBe("ip");
};

describe("buildGeocodingSearchUrl", () => {
  it("puts the search text in the path and fixes every other parameter", () => {
    const url = search("360 Huntington Ave");

    expect(url.origin).toBe("https://api.mapbox.com");
    expect(url.pathname).toBe(`${GEOCODING_PREFIX}360%20Huntington%20Ave.json`);
    expectFixedSearchParams(url);
    expect(url.searchParams.get("types")).toBe("address,postcode");
  });

  it("keeps the wire format the previous implementation sent for types", () => {
    // The old code interpolated the literal string "address%2Cpostcode", so
    // the bytes on the wire must not change even though the client now sends
    // a semantic name.
    expect(
      buildGeocodingSearchUrl({
        value: "x",
        type: "address",
        accessToken: TOKEN,
      }),
    ).toContain("types=address%2Cpostcode");
    expect(
      buildGeocodingSearchUrl({
        value: "x",
        type: "place",
        accessToken: TOKEN,
      }),
    ).toContain("types=neighborhood%2Cplace");
  });

  it("searches for an ampersand instead of starting a new parameter", () => {
    // The reported break: nobody could look up an address containing "&".
    const url = search("Marks & Spencer");

    expect(url.pathname).toBe(`${GEOCODING_PREFIX}Marks%20%26%20Spencer.json`);
    expectFixedSearchParams(url);
  });

  describe.each([
    { name: "extra query parameters", value: "x?types=poi&limit=10" },
    { name: "a parameter override", value: "x&access_token=stolen" },
    { name: "a fragment", value: "x#fragment" },
    { name: "a path escape", value: "../../../directions/v5/mapbox/driving/x" },
    { name: "an encoded path escape", value: "x%2F..%2Fdirections" },
    { name: "a batch separator", value: "boston;cambridge" },
    { name: "an absolute URL", value: "https://evil.example.com/x" },
    { name: "a newline", value: "x\nHost: evil.example.com" },
  ])("with $name in the search text", ({ value }) => {
    it("cannot leave the geocoding path or change a parameter", () => {
      const url = search(value);

      expect(url.origin).toBe("https://api.mapbox.com");
      expect(url.pathname.startsWith(GEOCODING_PREFIX)).toBe(true);
      // One path segment after the prefix: the encoded search text. Anything
      // that split into extra segments would show up here.
      expect(url.pathname.slice(GEOCODING_PREFIX.length).includes("/")).toBe(
        false,
      );
      expectFixedSearchParams(url);
      expect(url.searchParams.get("types")).toBe("address,postcode");
      // And the text really did survive as text.
      expect(
        decodeURIComponent(
          url.pathname.slice(GEOCODING_PREFIX.length).replace(/\.json$/, ""),
        ),
      ).toBe(value.trim());
    });
  });

  it("trims and rejects text that is only whitespace", () => {
    expect(search("  boston  ").pathname).toBe(
      `${GEOCODING_PREFIX}boston.json`,
    );
    expect(() =>
      buildGeocodingSearchUrl({
        value: "   ",
        type: "address",
        accessToken: TOKEN,
      }),
    ).toThrow(/must not be empty/);
  });

  it("rejects text longer than Mapbox accepts", () => {
    const atLimit = "a".repeat(MAPBOX_SEARCH_MAX_LENGTH);
    expect(() => search(atLimit)).not.toThrow();
    expect(() => search(`${atLimit}a`)).toThrow(/at most/);
  });
});

describe("buildDirectionsUrl", () => {
  const directions = (points: [number, number][]) =>
    new URL(buildDirectionsUrl({ points, accessToken: TOKEN }));

  it("joins coordinates with the separators Mapbox expects", () => {
    const url = directions([
      [-71.0892, 42.3398],
      [-71.0589, 42.3601],
    ]);

    expect(url.origin).toBe("https://api.mapbox.com");
    expect(url.pathname).toBe(
      "/directions/v5/mapbox/driving/-71.0892,42.3398;-71.0589,42.3601",
    );
    expect([...url.searchParams.keys()]).toEqual(["access_token"]);
    expect(url.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("accepts the largest route the app can produce", () => {
    // A full carpool is one driver plus six riders: start, a pickup and a
    // dropoff each, then the destination.
    const busiest: [number, number][] = Array.from({ length: 14 }, (_, i) => [
      -71 + i / 100,
      42 + i / 100,
    ]);
    expect(() => directions(busiest)).not.toThrow();
  });

  it("bounds how long a route a single call can ask for", () => {
    const tooMany: [number, number][] = Array.from(
      { length: MAPBOX_DIRECTIONS_MAX_POINTS + 1 },
      () => [-71, 42],
    );
    expect(() => directions(tooMany)).toThrow(/between 2 and 25 points/);
  });

  it("rejects a route with nowhere to go", () => {
    expect(() => directions([])).toThrow(/between 2 and 25 points/);
    expect(() => directions([[-71, 42]])).toThrow(/between 2 and 25 points/);
  });

  describe.each([
    { name: "longitude above range", point: [181, 42] },
    { name: "longitude below range", point: [-181, 42] },
    { name: "latitude above range", point: [-71, 91] },
    { name: "latitude below range", point: [-71, -91] },
    { name: "NaN", point: [NaN, 42] },
    { name: "Infinity", point: [-71, Infinity] },
  ])("with $name", ({ point }) => {
    it("refuses to build a URL", () => {
      expect(() => directions([[-71, 42], point as [number, number]])).toThrow(
        /out of range/,
      );
    });
  });
});
