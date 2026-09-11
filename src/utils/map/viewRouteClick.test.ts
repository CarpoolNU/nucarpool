import { Permission, Role, Status } from "@prisma/client";
import type { FeatureCollection } from "geojson";
import type { CarpoolAddress, GeoJsonUsers, PublicUser, User } from "../types";
import { runViewRouteClick } from "./viewRouteClick";
import { viewRoute } from "./viewRoute";
import clearOtherUserMarkers from "./clearOtherUserMarkers";
import updateCompanyLocation from "./updateCompanyLocation";
import updateUserLocation from "./updateUserLocation";

/**
 * The map helpers are the whole point of mocking here: each one reaches into a
 * live `mapboxgl.Map`, and none of the behaviour under test is about what
 * Mapbox draws. What is under test is *which* of them get called, in what
 * order, and whether `viewRoute` is reached at all - which for anyone absent
 * from the map it was not, for ten months, silently.
 *
 * `./viewRoute` is mocked as a partial module because this file is the only
 * consumer of its `viewRoute` export here; `clearDirections` and
 * `useGetDirections` belong to `pages/index.tsx`.
 */
jest.mock("./viewRoute", () => ({
  viewRoute: jest.fn(),
}));
jest.mock("./clearOtherUserMarkers", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./updateCompanyLocation", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./updateUserLocation", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const VIEWER_ID = "viewer-id";
const CLICKED_ID = "clicked-id";
const OTHER_ID = "other-id";

/** A stand-in for the map. Nothing under test reads anything off it. */
const map = {} as mapboxgl.Map;

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: VIEWER_ID,
  name: "Viewer",
  email: null,
  emailVerified: null,
  image: null,
  bio: "",
  preferredName: "Viewer",
  pronouns: "",
  permission: Permission.USER,
  isOnboarded: true,
  licenseSigned: true,
  dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  dateModified: new Date("2026-01-01T00:00:00.000Z"),
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Company",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
  carpoolId: null,
  groupNotes: null,
  groupMusicPreference: null,
  groupConversationStyle: null,
  groupMessage: null,
  startCoordLng: -71.1,
  startCoordLat: 42.3,
  startStreet: "",
  startCity: "",
  startState: "",
  startAddress: "",
  companyCoordLng: -71.05,
  companyCoordLat: 42.35,
  companyStreet: "",
  companyCity: "",
  companyState: "",
  companyAddress: "",
  ...overrides,
});

const buildPublicUser = (overrides: Partial<PublicUser> = {}): PublicUser => ({
  id: CLICKED_ID,
  name: "Clicked",
  image: null,
  bio: "",
  preferredName: "Clicked",
  pronouns: "",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
  companyName: "Company",
  startAddress: "",
  startCoordLng: -71.2,
  startCoordLat: 42.4,
  companyAddress: "",
  companyCoordLng: -71.05,
  companyCoordLat: 42.35,
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
  carpoolId: null,
  ...overrides,
});

const NO_ADDRESS: CarpoolAddress = { place_name: "", center: [0, 0] };
const PICKED_START: CarpoolAddress = {
  place_name: "10 Somewhere St",
  center: [-71.3, 42.5],
};
const PICKED_COMPANY: CarpoolAddress = {
  place_name: "20 Elsewhere Ave",
  center: [-71.4, 42.6],
};

/**
 * `mapbox.geoJsonUserList` returns a plain GeoJSON `FeatureCollection` whose
 * `properties` is a spread `PublicUser`. Only `properties.id` is read here, so
 * the features carry that alone; the cast is to `GeoJsonUsers`, which is the
 * router's inferred output type rather than something a test can spell.
 */
const geoJsonWith = (...ids: string[]): GeoJsonUsers => {
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: ids.map((id) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [-71.05, 42.35] },
      properties: { id },
    })),
  };

  return collection as GeoJsonUsers;
};

type RunArgs = Parameters<typeof runViewRouteClick>[0];

const run = (overrides: Partial<RunArgs> = {}) => {
  const setOtherUser = jest.fn();
  const setPoints = jest.fn();

  runViewRouteClick({
    user: buildUser(),
    clickedUser: buildPublicUser(),
    map,
    geoJsonUsers: geoJsonWith(),
    selectedUserId: null,
    startAddressSelected: NO_ADDRESS,
    companyAddressSelected: NO_ADDRESS,
    isMobile: false,
    setOtherUser,
    setPoints,
    ...overrides,
  });

  return { setOtherUser, setPoints };
};

/** The `updateCompanyLocation` calls that add or remove another user's pin. */
const destinationPinCalls = () =>
  jest
    .mocked(updateCompanyLocation)
    .mock.calls.filter((call) => call[6] === false)
    .map((call) => ({ userId: call[4], removed: call[7] }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("runViewRouteClick", () => {
  /**
   * The assertion that was missing for ten months.
   *
   * The old inline condition answered "draw the route?" with the negation of
   * `!isOtherUserInGeoList && selectedUserId !== clickedUser.id`, and returned
   * before `viewRoute` whenever that held - which was every click on a user the
   * map was not plotting, outside a conversation. Nothing was logged and no
   * toast was raised, so the only symptom was a button that did nothing.
   *
   * Stated over all four combinations rather than only the broken one: a
   * contradictory branch is invisible in review, and the fourth case is exactly
   * where this one hid.
   */
  describe("draws the route for every combination of inputs", () => {
    it.each([
      {
        name: "on the map, conversation theirs",
        onMap: true,
        selected: CLICKED_ID,
      },
      { name: "on the map, no conversation open", onMap: true, selected: null },
      {
        name: "off the map, conversation theirs",
        onMap: false,
        selected: CLICKED_ID,
      },
      {
        name: "off the map, no conversation open",
        onMap: false,
        selected: null,
      },
    ])("$name", ({ onMap, selected }) => {
      run({
        geoJsonUsers: onMap ? geoJsonWith(CLICKED_ID) : geoJsonWith(OTHER_ID),
        selectedUserId: selected,
      });

      expect(viewRoute).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Every case in here returned before `viewRoute` was reached.
   *
   * `geoJsonUserList` excludes everyone you have a request with whenever the
   * `messaged` filter is false, which is the default, so this is the ordinary
   * case rather than an edge one.
   */
  describe("a user the map is not plotting", () => {
    it("draws their route", () => {
      run({ geoJsonUsers: geoJsonWith(OTHER_ID) });

      expect(viewRoute).toHaveBeenCalledTimes(1);
      expect(jest.mocked(viewRoute).mock.calls[0]![0]).toMatchObject({
        otherUser: expect.objectContaining({ id: CLICKED_ID }),
        map,
      });
    });

    it("asks for the directions the route is drawn from", () => {
      const { setPoints } = run({ geoJsonUsers: geoJsonWith(OTHER_ID) });

      expect(setPoints).toHaveBeenCalledTimes(1);
    });

    it("gives them a destination pin, which nothing used to do", () => {
      run({ geoJsonUsers: geoJsonWith(OTHER_ID) });

      expect(destinationPinCalls()).toEqual([
        { userId: CLICKED_ID, removed: false },
      ]);
    });

    it("does not clear the selection it just made", () => {
      // The dead branch's `else if` ran `setOtherUser(null)` and returned, so
      // the click ended with the page pointing at nobody.
      const { setOtherUser } = run({ geoJsonUsers: geoJsonWith(OTHER_ID) });

      expect(setOtherUser).toHaveBeenCalledTimes(1);
      expect(setOtherUser).toHaveBeenCalledWith(
        expect.objectContaining({ id: CLICKED_ID }),
      );
    });

    it("draws the route with a different conversation open", () => {
      // A Requests-tab card pressed before its own conversation is opened.
      run({ geoJsonUsers: geoJsonWith(), selectedUserId: OTHER_ID });

      expect(viewRoute).toHaveBeenCalledTimes(1);
    });
  });

  describe("a user the map is already plotting", () => {
    it("draws their route", () => {
      run({ geoJsonUsers: geoJsonWith(CLICKED_ID) });

      expect(viewRoute).toHaveBeenCalledTimes(1);
    });

    it("adds no pin, because the cluster layer already draws them there", () => {
      run({ geoJsonUsers: geoJsonWith(CLICKED_ID) });

      expect(destinationPinCalls()).toEqual([]);
    });
  });

  /**
   * The path that worked, and the regression this change has to protect:
   * `MessagePanel`'s Map tab passes the same id as both the selection and the
   * click.
   */
  describe("request context", () => {
    it("draws the route and pins the counterpart", () => {
      run({ selectedUserId: CLICKED_ID });

      expect(viewRoute).toHaveBeenCalledTimes(1);
      expect(destinationPinCalls()).toEqual([
        { userId: CLICKED_ID, removed: false },
      ]);
    });

    it("leaves the page's otherUser state alone", () => {
      const { setOtherUser } = run({ selectedUserId: CLICKED_ID });

      expect(setOtherUser).not.toHaveBeenCalled();
    });

    it("still pins a counterpart the map is plotting", () => {
      run({
        selectedUserId: CLICKED_ID,
        geoJsonUsers: geoJsonWith(CLICKED_ID),
      });

      expect(destinationPinCalls()).toEqual([
        { userId: CLICKED_ID, removed: false },
      ]);
    });
  });

  /**
   * This block used to drive the remembered-pin ref
   * through its cases - a different user clicked, the same user re-clicked, the
   * remembered user appearing on the map - because removal was keyed by
   * identity and each case named a different pin.
   *
   * There is nothing to remember now. Every `other-user-*` layer goes at the
   * top of the handler, so the only question left is the one below: that the
   * sweep runs, and that it runs *before* this handler draws, not after.
   */
  describe("clearing what the previous view left behind", () => {
    it("sweeps every other user's pin first", () => {
      run();

      expect(clearOtherUserMarkers).toHaveBeenCalledWith(map);
      expect(clearOtherUserMarkers).toHaveBeenCalledTimes(1);
    });

    it("sweeps before adding this click's own pin, never after", () => {
      // The ordering is the acceptance criterion most easily broken by a later
      // edit: a sweep that ran afterwards would take off the pin this handler
      // just drew, trading a stale overlay for an empty one. Asserted through
      // invocation order rather than by reading the function top to bottom.
      run({ geoJsonUsers: geoJsonWith(OTHER_ID) });

      const sweptAt = jest.mocked(clearOtherUserMarkers).mock
        .invocationCallOrder[0]!;
      const pinnedAt = jest
        .mocked(updateCompanyLocation)
        .mock.calls.map((call, index) => ({ call, index }))
        .filter(({ call }) => call[6] === false)
        .map(
          ({ index }) =>
            jest.mocked(updateCompanyLocation).mock.invocationCallOrder[index]!,
        );

      expect(pinnedAt).toHaveLength(1);
      expect(sweptAt).toBeLessThan(pinnedAt[0]!);
    });

    it("removes no pin by name, having swept them all", () => {
      // `updateCompanyLocation(..., remove: true)` was the old removal call.
      // Nothing should reach for it now.
      run({ geoJsonUsers: geoJsonWith(OTHER_ID) });

      expect(destinationPinCalls().filter((call) => call.removed)).toEqual([]);
    });
  });

  describe("guards", () => {
    it("treats a feature collection with no feature list as plotting nobody", () => {
      // `FeatureCollection.features` is required by the geojson types, so this
      // is the `?? false` in the module defending against a payload that
      // violates them. Falling the other way would silently withhold the pin
      // from everyone.
      run({ geoJsonUsers: { type: "FeatureCollection" } as GeoJsonUsers });

      expect(viewRoute).toHaveBeenCalledTimes(1);
      expect(destinationPinCalls()).toEqual([
        { userId: CLICKED_ID, removed: false },
      ]);
    });

    it("does nothing without a map", () => {
      const { setOtherUser, setPoints } = run({ map: undefined });

      expect(viewRoute).not.toHaveBeenCalled();
      expect(setOtherUser).not.toHaveBeenCalled();
      expect(setPoints).not.toHaveBeenCalled();
      expect(clearOtherUserMarkers).not.toHaveBeenCalled();
    });

    it("does nothing before the map's user list has loaded", () => {
      const { setOtherUser } = run({ geoJsonUsers: undefined });

      expect(viewRoute).not.toHaveBeenCalled();
      expect(setOtherUser).not.toHaveBeenCalled();
    });

    it("refuses a clicked user with unusable coordinates", () => {
      const { setPoints } = run({
        clickedUser: buildPublicUser({ startCoordLng: NaN }),
      });

      expect(viewRoute).not.toHaveBeenCalled();
      expect(setPoints).not.toHaveBeenCalled();
      expect(destinationPinCalls()).toEqual([]);
    });

    it("refuses a viewer with unusable coordinates", () => {
      run({ user: buildUser({ companyCoordLat: Infinity }) });

      expect(viewRoute).not.toHaveBeenCalled();
    });

    it("still selects the clicked user before refusing on coordinates", () => {
      // Order preserved from the original handler, which set `otherUser`
      // ahead of the coordinate guard. `otherUser` is what holds the page's
      // initial-route effect shut, so moving it would change what the map
      // shows after a failed click.
      const { setOtherUser } = run({
        clickedUser: buildPublicUser({ companyCoordLng: NaN }),
      });

      expect(setOtherUser).toHaveBeenCalledWith(
        expect.objectContaining({ id: CLICKED_ID }),
      );
    });
  });

  describe("the viewer's own markers", () => {
    it("are updated for a rider or driver", () => {
      run();

      expect(updateUserLocation).toHaveBeenCalledTimes(1);
      expect(
        jest
          .mocked(updateCompanyLocation)
          .mock.calls.filter((call) => call[6] === true),
      ).toHaveLength(1);
    });

    it("are left alone for a viewer, who has none", () => {
      run({ user: buildUser({ role: Role.VIEWER }) });

      expect(updateUserLocation).not.toHaveBeenCalled();
      expect(
        jest
          .mocked(updateCompanyLocation)
          .mock.calls.filter((call) => call[6] === true),
      ).toHaveLength(0);
    });
  });

  /**
   * The four `setPoints` branches. Untestable while they sat in the page, and
   * the order of the points is the order Mapbox drives through them - so a
   * rider's route picks the rider up first and a driver's collects them on the
   * way.
   */
  describe("the points the directions request is built from", () => {
    const clicked = buildPublicUser();
    const viewer = buildUser();

    it("puts a rider's own pickup first", () => {
      const { setPoints } = run({ user: buildUser({ role: Role.RIDER }) });

      expect(setPoints).toHaveBeenCalledWith([
        [clicked.startCoordLng, clicked.startCoordLat],
        [viewer.startCoordLng, viewer.startCoordLat],
        [viewer.companyCoordLng, viewer.companyCoordLat],
        [clicked.companyCoordLng, clicked.companyCoordLat],
      ]);
    });

    it("starts a driver at their own home", () => {
      const { setPoints } = run({ user: buildUser({ role: Role.DRIVER }) });

      expect(setPoints).toHaveBeenCalledWith([
        [viewer.startCoordLng, viewer.startCoordLat],
        [clicked.startCoordLng, clicked.startCoordLat],
        [clicked.companyCoordLng, clicked.companyCoordLat],
        [viewer.companyCoordLng, viewer.companyCoordLat],
      ]);
    });

    it("draws only the other person's leg for a viewer with no address picked", () => {
      const { setPoints } = run({ user: buildUser({ role: Role.VIEWER }) });

      expect(setPoints).toHaveBeenCalledWith([
        [clicked.startCoordLng, clicked.startCoordLat],
        [clicked.companyCoordLng, clicked.companyCoordLat],
      ]);
    });

    it("uses a viewer's picked addresses as their own ends", () => {
      const { setPoints } = run({
        user: buildUser({ role: Role.VIEWER }),
        startAddressSelected: PICKED_START,
        companyAddressSelected: PICKED_COMPANY,
      });

      expect(setPoints).toHaveBeenCalledWith([
        PICKED_START.center,
        [clicked.startCoordLng, clicked.startCoordLat],
        [clicked.companyCoordLng, clicked.companyCoordLat],
        PICKED_COMPANY.center,
      ]);
      expect(jest.mocked(viewRoute).mock.calls[0]![0].userCoord).toEqual({
        startLng: PICKED_START.center[0],
        startLat: PICKED_START.center[1],
        endLng: PICKED_COMPANY.center[0],
        endLat: PICKED_COMPANY.center[1],
      });
    });

    it("sends no viewer coordinates when a viewer has picked no address", () => {
      run({ user: buildUser({ role: Role.VIEWER }) });

      expect(
        jest.mocked(viewRoute).mock.calls[0]![0].userCoord,
      ).toBeUndefined();
    });
  });
});
