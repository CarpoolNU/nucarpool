import {
  createAddressResolver,
  isRealGeocodingEnabled,
  MapboxFeature,
  parseMapboxFeatures,
  SEED_GEOCODE_ENV,
  synthesizeAddress,
} from "./seedAddresses";

const silent = () => undefined;

describe("synthesizeAddress", () => {
  it("is deterministic, so re-seeding reproduces the same addresses", () => {
    expect(synthesizeAddress(-71.1, 42.33)).toEqual(
      synthesizeAddress(-71.1, 42.33),
    );
  });

  it("produces a street, a Massachusetts city, and a combined address", () => {
    const address = synthesizeAddress(-71.1, 42.33);
    expect(address.street).toMatch(/^\d+ .+/);
    expect(address.city).not.toBe("");
    expect(address.state).toBe("MA");
    expect(address.address).toBe(`${address.street}, ${address.city}, MA`);
  });

  // The old code fell back to one hardcoded address for every user whenever
  // geocoding failed, which it always did without a Mapbox token.
  it("varies across nearby coordinates instead of collapsing onto one address", () => {
    const addresses = new Set<string>();
    for (let i = 0; i < 60; i++) {
      addresses.add(
        synthesizeAddress(-71.1 + i * 0.001, 42.33 + i * 0.001).address,
      );
    }
    expect(addresses.size).toBeGreaterThan(20);
  });

  it("distinguishes coordinates that differ within its precision", () => {
    expect(synthesizeAddress(-71.1, 42.33)).not.toEqual(
      synthesizeAddress(-71.10001, 42.33),
    );
  });
});

describe("isRealGeocodingEnabled", () => {
  it.each(["1", "true", "TRUE", " 1 "])("treats %p as opting in", (value) => {
    expect(isRealGeocodingEnabled(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "yes"])(
    "does not treat %p as opting in",
    (value) => {
      expect(isRealGeocodingEnabled(value)).toBe(false);
    },
  );
});

describe("parseMapboxFeatures", () => {
  it("splits a leading building number off the address feature", () => {
    const features: MapboxFeature[] = [
      { place_type: ["address"], text: "360 Huntington Ave" },
      { place_type: ["place"], text: "Boston" },
      { place_type: ["region"], text: "Massachusetts" },
    ];
    expect(parseMapboxFeatures(features)).toEqual({
      street: "360 Huntington Ave",
      city: "Boston",
      state: "Massachusetts",
      address: "360 Huntington Ave, Boston, Massachusetts",
    });
  });

  it("keeps the text intact when it does not start with a number", () => {
    const features: MapboxFeature[] = [
      { place_type: ["address"], text: "Huntington Ave" },
    ];
    expect(parseMapboxFeatures(features).street).toBe("Huntington Ave");
  });

  it("prefers a point of interest for the display address", () => {
    const features: MapboxFeature[] = [
      { place_type: ["address"], text: "360 Huntington Ave" },
      { place_type: ["place"], text: "Boston" },
      { place_type: ["poi"], text: "Northeastern University" },
    ];
    expect(parseMapboxFeatures(features).address).toBe(
      "Northeastern University",
    );
  });

  it("takes the first place and region and ignores later ones", () => {
    const features: MapboxFeature[] = [
      { place_type: ["place"], text: "Boston" },
      { place_type: ["place"], text: "Cambridge" },
      { place_type: ["region"], text: "Massachusetts" },
      { place_type: ["region"], text: "New York" },
    ];
    const parsed = parseMapboxFeatures(features);
    expect(parsed.city).toBe("Boston");
    expect(parsed.state).toBe("Massachusetts");
  });

  it("tolerates an empty feature list and malformed features", () => {
    expect(parseMapboxFeatures([])).toEqual({
      street: "",
      city: "",
      state: "",
      address: ", , ",
    });
    expect(() => parseMapboxFeatures([{}])).not.toThrow();
  });
});

describe("createAddressResolver", () => {
  it("never touches the network by default", async () => {
    const fetchImpl = jest.fn();
    const resolve = createAddressResolver({
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onNotice: silent,
    });

    const address = await resolve(-71.1, 42.33);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(address).toEqual(synthesizeAddress(-71.1, 42.33));
  });

  it("stays offline when opted in without a Mapbox token", async () => {
    const fetchImpl = jest.fn();
    const resolve = createAddressResolver({
      env: { [SEED_GEOCODE_ENV]: "1" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onNotice: silent,
    });

    await resolve(-71.1, 42.33);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says which mode it is in, so the operator is not guessing", () => {
    const notices: string[] = [];
    createAddressResolver({ env: {}, onNotice: (m) => notices.push(m) });
    expect(notices.join(" ")).toContain(SEED_GEOCODE_ENV);
  });

  describe("when geocoding is enabled with a token", () => {
    const env = {
      [SEED_GEOCODE_ENV]: "1",
      NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN: "not-a-real-token",
    };

    const okResponse = () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          features: [
            { place_type: ["address"], text: "360 Huntington Ave" },
            { place_type: ["place"], text: "Boston" },
            { place_type: ["region"], text: "Massachusetts" },
          ],
        }),
      }) as unknown as Response;

    it("uses the geocoded result", async () => {
      const fetchImpl = jest.fn(async () => okResponse());
      const resolve = createAddressResolver({
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onNotice: silent,
      });

      expect((await resolve(-71.1, 42.33)).city).toBe("Boston");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("caches per coordinate, so a repeated coordinate costs no quota", async () => {
      const fetchImpl = jest.fn(async () => okResponse());
      const resolve = createAddressResolver({
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onNotice: silent,
      });

      await Promise.all([
        resolve(-71.1, 42.33),
        resolve(-71.1, 42.33),
        resolve(-71.1, 42.33),
      ]);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("still issues one request per distinct coordinate", async () => {
      const fetchImpl = jest.fn(async () => okResponse());
      const resolve = createAddressResolver({
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onNotice: silent,
      });

      await Promise.all([resolve(-71.1, 42.33), resolve(-71.2, 42.34)]);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // Previously an HTTP error produced `data.features === undefined`, threw,
    // and returned the same hardcoded address for every caller.
    it("synthesises on a non-ok response rather than reusing one address", async () => {
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(silent);
      const fetchImpl = jest.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            json: async () => ({}),
          }) as unknown as Response,
      );
      const resolve = createAddressResolver({
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onNotice: silent,
      });

      const [a, b] = await Promise.all([
        resolve(-71.1, 42.33),
        resolve(-71.2, 42.34),
      ]);

      expect(a).toEqual(synthesizeAddress(-71.1, 42.33));
      expect(b).toEqual(synthesizeAddress(-71.2, 42.34));
      expect(a.address).not.toBe(b.address);
      consoleError.mockRestore();
    });

    it("synthesises when the request rejects outright", async () => {
      const consoleError = jest
        .spyOn(console, "error")
        .mockImplementation(silent);
      const fetchImpl = jest.fn(async () => {
        throw new Error("network down");
      });
      const resolve = createAddressResolver({
        env,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onNotice: silent,
      });

      expect(await resolve(-71.1, 42.33)).toEqual(
        synthesizeAddress(-71.1, 42.33),
      );
      consoleError.mockRestore();
    });
  });
});
