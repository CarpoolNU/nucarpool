import { Location, Permission, Role, Status } from "@prisma/client";
import type { Session } from "next-auth";
import { appRouter } from "./index";
import type { Context } from "./context";
import {
  MAP_RESULT_LIMIT,
  limitMapResults,
  viewerReferencePoint,
  viewerReferenceSearch,
} from "./mapbox";
import { NEU_LAT, NEU_LNG } from "../../utils/map/mapHomeCentre";
import { fakeBlockDelegate } from "../../testing/blockFake";
import {
  DISTANCE_FILTER_ANY,
  TIME_FILTER_ANY,
} from "../../utils/filters/filterSentinels";

/**
 * Input validation and upstream-call wiring for the Mapbox proxy.
 *
 * `mapboxUrls.test.ts` covers URL construction. What is left to get wrong here
 * is the procedure: forwarding the wrong field, accepting input the builder
 * cannot safely handle, or treating a Mapbox error body as a successful
 * response.
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

  it("sends a token and the server-fixed parameters the client cannot influence", async () => {
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
    // Without this check, `data.features.map` runs directly on a Mapbox
    // error body, which throws a TypeError instead of reporting the failure.
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

describe("limitMapResults — how many points a reader receives", () => {
  /**
   * The cap, pinned, and the reason it is now role-independent.
   *
   * **This file used to pin the opposite.** A VIEWER was exempt, because the
   * map ranks by distance from the reader's own stored coordinates, a VIEWER is
   * allowed not to have any, and the addresses they browse by were picked in
   * the browser and never sent. SCRUM-642 sends them — see
   * `viewerReferenceSearch` — which is what makes "the nearest
   * `MAP_RESULT_LIMIT`" mean something for that role and lets the cap apply to
   * everyone.
   *
   * The two halves are one decision. `limitMapResults` no longer takes a role
   * at all, so re-adding the exemption cannot be done here without also
   * changing the signature — which is deliberate, and the only reason the
   * parameter was dropped rather than kept and ignored.
   *
   * These assert the boundary rather than a round number, so raising
   * `MAP_RESULT_LIMIT` does not require editing them.
   */
  const searches = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("caps an over-long set at MAP_RESULT_LIMIT", () => {
    expect(limitMapResults(searches(MAP_RESULT_LIMIT + 25))).toHaveLength(
      MAP_RESULT_LIMIT,
    );
  });

  it("keeps the ranked order, taking the best rather than an arbitrary slice", () => {
    // `sortedSearches` arrives best-first, so the cap has to take the head.
    expect(limitMapResults([0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
    expect(limitMapResults(searches(MAP_RESULT_LIMIT + 1))[0]).toBe(0);
  });

  it("leaves a set already under the limit untouched", () => {
    expect(limitMapResults([0, 1, 2])).toEqual([0, 1, 2]);
  });
});

describe("viewerReferencePoint — what a VIEWER is ranked around", () => {
  it("uses a picked address when there is one", () => {
    expect(viewerReferencePoint({ lat: 42.5, lng: -71.2 })).toEqual({
      coordLat: 42.5,
      coordLng: -71.2,
      source: "picked",
    });
  });

  /**
   * The campus fallback, and why it is campus rather than anything else:
   * `mapHomeCentre` already opens a VIEWER's map on this point, so the bounded
   * set is bounded around what they are looking at. A fallback that disagreed
   * with the map centre would cap the response around one place and draw
   * another — the failure the old exemption existed to avoid.
   */
  it("falls back to campus when nothing was picked", () => {
    expect(viewerReferencePoint(undefined)).toEqual({
      coordLat: NEU_LAT,
      coordLng: NEU_LNG,
      source: "campus",
    });
  });

  /**
   * `(0, 0)` is a valid WGS 84 coordinate, so the input schema accepts it, and
   * it is exactly what `useAddressSelection` holds before an address is picked.
   * The client drops it, but the server must not depend on that.
   */
  it("treats the unresolved sentinel as nothing picked", () => {
    expect(viewerReferencePoint({ lat: 0, lng: 0 })).toEqual({
      coordLat: NEU_LAT,
      coordLng: NEU_LNG,
      source: "campus",
    });
  });

  it("keeps a real coordinate that has one zero component", () => {
    // Greenwich and the equator are places; only the exact pair is the
    // sentinel. Mirrors `isUnresolvedCoordinate`'s own exactness.
    expect(viewerReferencePoint({ lat: 51.48, lng: 0 }).source).toBe("picked");
    expect(viewerReferencePoint({ lat: 0, lng: -71.09 }).source).toBe("picked");
  });
});

describe("viewerReferenceSearch — whose coordinates the ranking uses", () => {
  const location = (coordLat: number, coordLng: number): Location => ({
    id: "loc",
    city: "",
    state: "",
    street: "",
    streetAddress: "",
    coordLat,
    coordLng,
    dateCreated: new Date(0),
    dateModified: new Date(0),
  });

  const search = (role: Role) => ({
    role,
    homeLocation: location(42.1, -71.1),
    companyLocation: location(42.2, -71.2),
  });

  /**
   * AC: "Non-VIEWER behaviour is byte-for-byte unchanged." Asserted by
   * reference identity rather than by `toEqual`, which an unnecessary copy
   * would still satisfy.
   */
  it.each([Role.DRIVER, Role.RIDER])(
    "returns a %s's own search untouched, by identity",
    (role) => {
      const own = search(role);
      expect(
        viewerReferenceSearch(own, {
          viewerStart: { lat: 1, lng: 1 },
          viewerCompany: { lat: 2, lng: 2 },
        }),
      ).toBe(own);
    },
  );

  it("substitutes both picked points for a VIEWER", () => {
    const result = viewerReferenceSearch(search(Role.VIEWER), {
      viewerStart: { lat: 42.37, lng: -71.06 },
      viewerCompany: { lat: 42.39, lng: -71.14 },
    });

    expect(result.homeLocation).toMatchObject({
      coordLat: 42.37,
      coordLng: -71.06,
    });
    expect(result.companyLocation).toMatchObject({
      coordLat: 42.39,
      coordLng: -71.14,
    });
  });

  /**
   * The documented behaviour AC 3 asks for: a VIEWER who picked nothing is
   * ranked around campus, not around `(0, 0)` and not around whatever stale
   * `Location` their row happens to carry from a previous role.
   */
  it("ranks a VIEWER who picked nothing around campus, not their stored row", () => {
    const result = viewerReferenceSearch(search(Role.VIEWER), {});

    expect(result.homeLocation).toMatchObject({
      coordLat: NEU_LAT,
      coordLng: NEU_LNG,
    });
    expect(result.companyLocation).toMatchObject({
      coordLat: NEU_LAT,
      coordLng: NEU_LNG,
    });
  });

  it("falls back per point, so one pick does not need the other", () => {
    const result = viewerReferenceSearch(search(Role.VIEWER), {
      viewerStart: { lat: 42.37, lng: -71.06 },
    });

    expect(result.homeLocation).toMatchObject({ coordLat: 42.37 });
    expect(result.companyLocation).toMatchObject({ coordLat: NEU_LAT });
  });

  it("builds a usable Location for a VIEWER with no stored row at all", () => {
    const result = viewerReferenceSearch(
      { role: Role.VIEWER, homeLocation: null, companyLocation: null },
      { viewerStart: { lat: 42.37, lng: -71.06 } },
    );

    // Not null, and carrying every column `calculateScore` and
    // `buildCandidateWhere` read.
    expect(result.homeLocation).toMatchObject({
      coordLat: 42.37,
      coordLng: -71.06,
    });
    expect(result.companyLocation).not.toBeNull();
  });
});

/**
 * The endpoint itself, which is where the two halves meet: a VIEWER is capped
 * *and* the 150 they get are the 150 nearest the point they are browsing.
 *
 * Neither half is worth much alone. The unit tests above pin the cap and the
 * reference point separately, and both would keep passing if the procedure
 * stopped calling one of them — so the assertions that matter run through
 * `createCaller` against a Prisma double.
 *
 * The double ignores `where` and returns every candidate. That is deliberate:
 * these tests are about ranking and slicing, not about which rows SQL selects,
 * and a double that re-implemented `buildCandidateWhere` would be asserting
 * its own arithmetic. `candidateFilters.test.ts` covers the `where`.
 */
describe("geoJsonUserList — a VIEWER's bounded, ranked response", () => {
  /**
   * The second cluster's centre, 39 miles from campus — far enough that the
   * two clusters never interleave, since each spreads over about 7 miles.
   *
   * **South-east of campus, and that direction is load-bearing.** It puts this
   * cluster *nearer* `(0, 0)` than campus is (5,397 miles against 5,435), so a
   * ranking that honoured the unresolved sentinel would return these rows
   * first. A cluster north-west of campus is further from the origin than
   * campus is, and the sentinel test below would then pass whether or not
   * `viewerReferencePoint` rejected `(0, 0)` at all — which is what it looked
   * like before the figures were checked.
   */
  const FAR = { lat: 41.9, lng: -70.6 };

  const NEAR_CAMPUS = 160;
  const NEAR_FAR = 40;

  const location = (coordLat: number, coordLng: number): Location => ({
    id: "loc",
    city: "Boston",
    state: "MA",
    street: "",
    streetAddress: "",
    coordLat,
    coordLng,
    dateCreated: new Date(0),
    dateModified: new Date(0),
  });

  /**
   * A matchable DRIVER. Spread by `index` so the two clusters are ordered
   * within themselves and the tie-breaking is not what is being asserted.
   */
  const candidate = (id: string, lat: number, lng: number, index: number) => {
    const at = location(lat + index * 0.0005, lng + index * 0.0005);
    return {
      id: `search-${id}`,
      userId: id,
      role: Role.DRIVER,
      status: Status.ACTIVE,
      carpoolId: null,
      seatsAvail: 3,
      companyName: "",
      daysWorking: "0,1,1,1,1,1,0",
      startTime: null,
      endTime: null,
      startDate: null,
      endDate: null,
      homeLocation: at,
      companyLocation: at,
      user: {
        id,
        name: id,
        image: null,
        bio: "",
        preferredName: id,
        pronouns: "",
        isOnboarded: true,
      },
    };
  };

  const candidates = [
    ...Array.from({ length: NEAR_CAMPUS }, (_, i) =>
      candidate(`campus-${i}`, NEU_LAT, NEU_LNG, i),
    ),
    ...Array.from({ length: NEAR_FAR }, (_, i) =>
      candidate(`far-${i}`, FAR.lat, FAR.lng, i),
    ),
  ];

  /** The reader's own row, as `geoJsonUserList` loads it. */
  const readerSearch = (
    role: Role,
    home: Location | null,
    company: Location | null,
  ) => ({
    id: "search-me",
    userId: "user-1",
    role,
    status: Status.ACTIVE,
    carpoolId: null,
    seatsAvail: 0,
    companyName: "",
    daysWorking: "0,1,1,1,1,1,0",
    startTime: null,
    endTime: null,
    startDate: null,
    endDate: null,
    homeLocation: home,
    companyLocation: company,
    user: { id: "user-1", isOnboarded: true },
  });

  const prismaFor = (reader: ReturnType<typeof readerSearch>) => ({
    carpoolSearch: {
      findFirst: jest.fn(async () => reader),
      findMany: jest.fn(async () => candidates),
    },
    block: fakeBlockDelegate(),
  });

  /**
   * A VIEWER with no `Location` rows at all — the common case the old
   * exemption was written for, and the one `(0, 0)` used to describe.
   */
  const viewerPrisma = () => prismaFor(readerSearch(Role.VIEWER, null, null));

  const callerWith = (prisma: unknown) =>
    appRouter.createCaller({
      req: undefined,
      res: undefined,
      session,
      prisma,
      sesClient: { send: jest.fn() },
    } as unknown as Context);

  /** Every cutoff switched off, so ranking is the only thing acting. */
  const filters = {
    days: 0,
    daysWorking: "",
    flexDays: 1,
    startDistance: DISTANCE_FILTER_ANY,
    endDistance: DISTANCE_FILTER_ANY,
    startTime: TIME_FILTER_ANY,
    endTime: TIME_FILTER_ANY,
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    endDate: new Date("2026-06-01T00:00:00.000Z"),
    dateOverlap: 0,
    favorites: false,
    messaged: true,
  };

  const idsFrom = (collection: { features: { properties: any }[] }) =>
    collection.features.map((feature) => feature.properties.id as string);

  /**
   * The headline acceptance criterion. Before SCRUM-642 this returned all
   * `NEAR_CAMPUS + NEAR_FAR` candidates — every matchable profile the query
   * found — because a VIEWER was exempt from the cap.
   */
  it("caps a VIEWER at MAP_RESULT_LIMIT like every other role", async () => {
    const result =
      await callerWith(viewerPrisma()).mapbox.geoJsonUserList(filters);

    expect(candidates.length).toBeGreaterThan(MAP_RESULT_LIMIT);
    expect(result.features).toHaveLength(MAP_RESULT_LIMIT);
  });

  /**
   * And the cap is meaningful rather than arbitrary: with nothing picked, the
   * 150 kept are the ones nearest campus, which is where `mapHomeCentre` has
   * already put this user's map.
   */
  it("ranks a VIEWER who picked nothing around campus", async () => {
    const ids = idsFrom(
      await callerWith(viewerPrisma()).mapbox.geoJsonUserList(filters),
    );

    expect(ids.every((id) => id.startsWith("campus-"))).toBe(true);
  });

  /**
   * Both directions, because one alone is satisfiable by accident. Ranking
   * from the unsubstituted `(0, 0)` also puts the far cluster first — that is
   * exactly what `FAR`'s placement arranges — so a test that only picked `FAR`
   * would still pass if the substitution were removed entirely. Picking the
   * campus point is the case only a real substitution can satisfy.
   */
  it.each([
    { name: "the far cluster", pick: FAR, expected: "far-" },
    {
      name: "campus",
      pick: { lat: NEU_LAT, lng: NEU_LNG },
      expected: "campus-",
    },
  ])(
    "ranks a VIEWER around $name when they pick it",
    async ({ pick, expected }) => {
      const ids = idsFrom(
        await callerWith(viewerPrisma()).mapbox.geoJsonUserList({
          ...filters,
          viewerStart: pick,
          viewerCompany: pick,
        }),
      );

      // The picked cluster is wholly ahead of the other one.
      const head = expected === "far-" ? NEAR_FAR : MAP_RESULT_LIMIT;
      expect(ids.slice(0, head).every((id) => id.startsWith(expected))).toBe(
        true,
      );
      expect(ids).toHaveLength(MAP_RESULT_LIMIT);
    },
  );

  /**
   * The sentinel again, at the boundary rather than in the helper: a client
   * that sends `[0, 0]` unchanged must not be ranked from the Gulf of Guinea.
   * Verified to fail without the re-check — see the note on `FAR`, which is
   * placed so that honouring the sentinel puts the far cluster first.
   */
  it("ignores the unresolved sentinel sent as a reference point", async () => {
    const ids = idsFrom(
      await callerWith(viewerPrisma()).mapbox.geoJsonUserList({
        ...filters,
        viewerStart: { lat: 0, lng: 0 },
        viewerCompany: { lat: 0, lng: 0 },
      }),
    );

    expect(ids.every((id) => id.startsWith("campus-"))).toBe(true);
  });

  /**
   * A reference point outside WGS 84 is refused at the input boundary rather
   * than fed to `Math.cos`, matching what `getDirections` already does with
   * the points it forwards upstream.
   */
  it.each([
    { name: "latitude", point: { lat: 91, lng: -71 } },
    { name: "longitude", point: { lat: 42, lng: -181 } },
    { name: "NaN", point: { lat: NaN, lng: -71 } },
  ])("rejects an out-of-range $name", async ({ point }) => {
    await expect(
      callerWith(viewerPrisma()).mapbox.geoJsonUserList({
        ...filters,
        viewerStart: point,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  /**
   * AC: non-VIEWER behaviour unchanged. A RIDER sends no reference point, and
   * one sent anyway must not move their ranking off their own stored row —
   * `viewerReferenceSearch` returns their search by identity, and this is the
   * same claim asserted where it can actually be observed.
   */
  it("ignores a reference point sent by a RIDER", async () => {
    const riderPrisma = prismaFor(
      readerSearch(
        Role.RIDER,
        location(NEU_LAT, NEU_LNG),
        location(NEU_LAT, NEU_LNG),
      ),
    );

    const ids = idsFrom(
      await callerWith(riderPrisma).mapbox.geoJsonUserList({
        ...filters,
        viewerStart: FAR,
        viewerCompany: FAR,
      }),
    );

    // Still ranked around the rider's own campus-side row, not around FAR.
    expect(ids.every((id) => id.startsWith("campus-"))).toBe(true);
  });
});
