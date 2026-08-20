import { parseMapboxFeature } from "./parseAddress";

/**
 * `parseMapboxFeature` turns a Mapbox geocoding result into the street/city/state
 * triple stored on a `Location`. Mapbox does not guarantee any particular context
 * entries, so the fallbacks are the part worth pinning down.
 */

const feature = (overrides: Record<string, unknown> = {}) => ({
  id: "address.123",
  text: "Huntington Ave",
  place_name: "360 Huntington Ave, Boston, Massachusetts 02115, United States",
  center: [-71.0892, 42.3398],
  geometry: { type: "Point", coordinates: [-71.0892, 42.3398] },
  properties: {},
  type: "Feature",
  context: [
    { id: "postcode.1", text: "02115" },
    { id: "place.2", text: "Boston" },
    { id: "region.3", text: "Massachusetts" },
    { id: "country.4", text: "United States" },
  ],
  ...overrides,
});

describe("parseMapboxFeature", () => {
  it("reads the street from text and the city and state from context", () => {
    expect(parseMapboxFeature(feature())).toMatchObject({
      street: "Huntington Ave",
      city: "Boston",
      state: "Massachusetts",
    });
  });

  it("passes the identifying fields straight through", () => {
    const result = parseMapboxFeature(feature());

    expect(result).toMatchObject({
      id: "address.123",
      place_name:
        "360 Huntington Ave, Boston, Massachusetts 02115, United States",
      center: [-71.0892, 42.3398],
      type: "Feature",
    });
  });

  it("keeps a leading building number attached to the street", () => {
    const result = parseMapboxFeature(feature({ text: "360 Huntington Ave" }));

    expect(result.street).toBe("360 Huntington Ave");
  });

  it("falls back to neighborhood when there is no place entry", () => {
    const result = parseMapboxFeature(
      feature({
        context: [
          { id: "neighborhood.1", text: "Fenway" },
          { id: "region.3", text: "Massachusetts" },
        ],
      }),
    );

    expect(result.city).toBe("Fenway");
  });

  it("falls back to locality when there is neither place nor neighborhood", () => {
    const result = parseMapboxFeature(
      feature({
        context: [
          { id: "locality.1", text: "Mission Hill" },
          { id: "region.3", text: "Massachusetts" },
        ],
      }),
    );

    expect(result.city).toBe("Mission Hill");
  });

  it("takes whichever city-ish context entry comes first, not the most specific one (SCRUM-265)", () => {
    // The comments describe neighborhood and locality as fallbacks for place, but
    // the loop stops at the first match in array order. Mapbox orders context from
    // smallest to largest scope, so a neighborhood entry wins over the real city.
    const neighborhoodFirst = parseMapboxFeature(
      feature({
        context: [
          { id: "neighborhood.1", text: "Fenway" },
          { id: "place.2", text: "Boston" },
        ],
      }),
    );
    const placeFirst = parseMapboxFeature(
      feature({
        context: [
          { id: "place.2", text: "Boston" },
          { id: "neighborhood.1", text: "Fenway" },
        ],
      }),
    );

    expect(neighborhoodFirst.city).toBe("Fenway");
    expect(placeFirst.city).toBe("Boston");
  });

  it("parses city and state out of place_name when there is no context at all", () => {
    const result = parseMapboxFeature(
      feature({
        context: undefined,
        text: "",
        place_name: "12 Highland Ave, Somerville, MA 02143, United States",
      }),
    );

    expect(result).toMatchObject({
      street: "Highland Ave",
      city: "Somerville",
      state: "MA",
    });
  });

  it("stops reading the state at the postcode", () => {
    const result = parseMapboxFeature(
      feature({
        context: [],
        text: "",
        place_name: "1 Main St, Springfield, New Hampshire 03284",
      }),
    );

    expect(result.state).toBe("New Hampshire");
  });

  it("splits a two-letter state off the city when place_name has no separate state part", () => {
    const result = parseMapboxFeature(
      feature({
        context: [],
        text: "",
        place_name: "1 Main St, Somerville MA",
      }),
    );

    expect(result).toMatchObject({ city: "Somerville", state: "MA" });
  });

  it("does not mistake a lowercase two-letter word for a state abbreviation", () => {
    const result = parseMapboxFeature(
      feature({
        context: [],
        text: "",
        place_name: "1 Main St, Somerville ma",
      }),
    );

    expect(result.state).toBe("");
    expect(result.city).toBe("Somerville ma");
  });

  it("uses context values in preference to anything place_name suggests", () => {
    const result = parseMapboxFeature(
      feature({
        text: "Huntington Ave",
        place_name: "999 Elsewhere Rd, Providence, RI 02903",
        context: [
          { id: "place.2", text: "Boston" },
          { id: "region.3", text: "Massachusetts" },
        ],
      }),
    );

    expect(result).toMatchObject({
      street: "Huntington Ave",
      city: "Boston",
      state: "Massachusetts",
    });
  });

  it("returns empty strings rather than undefined when nothing can be parsed", () => {
    const result = parseMapboxFeature({
      id: "poi.1",
      center: [0, 0],
    });

    expect(result).toMatchObject({ street: "", city: "", state: "" });
  });

  it("drops a street that is nothing but a building number, then recovers it from place_name", () => {
    // "360" alone is treated as a building number with no street left over, so the
    // place_name fallback supplies the street instead.
    const result = parseMapboxFeature(
      feature({
        text: "360",
        place_name: "360 Huntington Ave, Boston, MA 02115",
      }),
    );

    expect(result.street).toBe("Huntington Ave");
  });
});
