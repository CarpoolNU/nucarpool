import { Permission } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";

/**
 * Input validation and upstream-call wiring for the Mapbox proxy.
 *
 * `mapboxUrls.test.ts` covers URL construction. What is left to get wrong here
 * is the procedure: forwarding the wrong field, accepting input the builder
 * cannot safely handle, or — as the old code did — treating a Mapbox error
 * body as a successful response.
 *
 * `fetch` is mocked throughout. Nothing in this file reaches Mapbox or
 * consumes quota.
 */

const GEOCODING_PREFIX = "/geocoding/v5/mapbox.places/";

const session: Session = {
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    id: "user-1",
    isOnboarded: true,
    tutorialCompleted: true,
    permission: Permission.USER,
  },
};

const caller = () =>
  appRouter.createCaller({
    req: undefined,
    res: undefined,
    session,
    prisma: {},
    sesClient: { send: jest.fn() },
  } as unknown as Context);

const jsonResponse = (body: unknown, init: { status?: number } = {}) =>
  ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response;

let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  fetchSpy = jest
    .spyOn(global, "fetch")
    .mockResolvedValue(
      jsonResponse({ type: "FeatureCollection", features: [] }),
    );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

/** The URL the procedure actually asked for. */
const requestedUrl = () => new URL(String(fetchSpy.mock.calls[0]?.[0]));

describe("mapbox.search — input", () => {
  it("forwards the search text and the chosen category", async () => {
    await caller().mapbox.search({
      value: "360 Huntington Ave",
      types: "address",
    });

    const url = requestedUrl();
    expect(url.pathname).toBe(`${GEOCODING_PREFIX}360%20Huntington%20Ave.json`);
    expect(url.searchParams.get("types")).toBe("address,postcode");
  });

  it("uses the other category when asked for it", async () => {
    await caller().mapbox.search({ value: "Fenway", types: "place" });

    expect(requestedUrl().searchParams.get("types")).toBe("neighborhood,place");
  });

  it("sends a token and the parameters the client can no longer influence", async () => {
    await caller().mapbox.search({ value: "x", types: "address" });

    const url = requestedUrl();
    // Asserted by presence, not value: the value is a CI placeholder here and
    // a real token in production, and neither belongs in an assertion.
    expect(url.searchParams.get("access_token")).toBeTruthy();
    expect(url.searchParams.get("autocomplete")).toBe("true");
    expect(url.searchParams.get("country")).toBe("us");
    expect(url.searchParams.get("proximity")).toBe("ip");
  });

  it("trims before searching", async () => {
    await caller().mapbox.search({ value: "  boston  ", types: "address" });

    expect(requestedUrl().pathname).toBe(`${GEOCODING_PREFIX}boston.json`);
  });

  it.each([
    { name: "empty text", value: "" },
    { name: "whitespace only", value: "   " },
    { name: "text past the Mapbox limit", value: "a".repeat(257) },
  ])("rejects $name without calling Mapbox", async ({ value }) => {
    await expect(
      caller().mapbox.search({ value, types: "address" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a category it does not offer", async () => {
    await expect(
      caller().mapbox.search({
        value: "x",
        types: "poi" as unknown as "address",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("mapbox.search — upstream responses", () => {
  it("surfaces a non-2xx instead of parsing the error body as results", async () => {
    // The old code went straight to `data.features.map`, which threw a
    // TypeError on a Mapbox error body rather than reporting the failure.
    fetchSpy.mockResolvedValue(
      jsonResponse({ message: "Not Authorized" }, { status: 401 }),
    );

    await expect(
      caller().mapbox.search({ value: "x", types: "address" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("surfaces a 200 whose body has no features array", async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ message: "something else" }));

    await expect(
      caller().mapbox.search({ value: "x", types: "address" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });

  it("surfaces a network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      caller().mapbox.search({ value: "x", types: "address" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
});

describe("mapbox.getDirections — input", () => {
  const okRoute = { code: "Ok", routes: [{ geometry: "abc" }] };

  it("forwards waypoints in order", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(okRoute));

    await caller().mapbox.getDirections({
      points: [
        [-71.0892, 42.3398],
        [-71.0589, 42.3601],
      ],
    });

    expect(requestedUrl().pathname).toBe(
      "/directions/v5/mapbox/driving/-71.0892,42.3398;-71.0589,42.3601",
    );
  });

  it.each([
    { name: "no points", points: [] },
    { name: "a single point", points: [[-71, 42]] },
    {
      name: "more waypoints than Mapbox allows",
      points: Array.from({ length: 26 }, () => [-71, 42]),
    },
    {
      name: "longitude out of range",
      points: [
        [-71, 42],
        [181, 42],
      ],
    },
    {
      name: "latitude out of range",
      points: [
        [-71, 42],
        [-71, 91],
      ],
    },
    {
      name: "NaN",
      points: [
        [-71, 42],
        [NaN, 42],
      ],
    },
    {
      name: "Infinity",
      points: [
        [-71, 42],
        [-71, Infinity],
      ],
    },
  ])("rejects $name without calling Mapbox", async ({ points }) => {
    await expect(
      caller().mapbox.getDirections({
        points: points as [number, number][],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
