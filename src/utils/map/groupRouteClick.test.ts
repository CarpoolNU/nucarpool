/**
 * **Preview Group Route** (SCRUM-391).
 *
 * The defect: this handler added a destination pin for every group member and
 * nothing ever took them off, so they outlived the route they belonged to, the
 * tab they were drawn on, and the session. It was unreachable by any test while
 * the handler was a closure inside `pages/index.tsx`, which is why extracting
 * it is part of the fix rather than tidying beside it.
 *
 * The assertions that matter are the two halves of "sweep, then draw": that the
 * sweep happens at all, and that it happens *first*. A sweep after the pins
 * would trade a stale overlay for an empty one, and both orderings make the
 * function read as though it cleans up.
 */

import type mapboxgl from "mapbox-gl";
import { Permission, Role, Status } from "@prisma/client";
import type { PublicUser, User } from "../types";
import { runViewGroupRoute } from "./groupRouteClick";
import { clearDirections, clearMarkers } from "./viewRoute";
import clearOtherUserMarkers from "./clearOtherUserMarkers";
import updateCompanyLocation from "./updateCompanyLocation";
import updateStartLocation from "./updateStartLocation";
import updateUserLocation from "./updateUserLocation";

jest.mock("./viewRoute", () => ({
  clearDirections: jest.fn(),
  clearMarkers: jest.fn(),
}));
jest.mock("./clearOtherUserMarkers", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./updateCompanyLocation", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./updateStartLocation", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./updateUserLocation", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const VIEWER_ID = "viewer-id";
const DRIVER_ID = "driver-id";
const RIDER_ID = "rider-id";

const fitBounds = jest.fn();
const map = { fitBounds } as unknown as mapboxgl.Map;

const buildUser = (overrides: Partial<User> = {}): User =>
  ({
    id: VIEWER_ID,
    name: "Viewer",
    preferredName: "Viewer",
    pronouns: "",
    bio: "",
    permission: Permission.USER,
    isOnboarded: true,
    role: Role.RIDER,
    status: Status.ACTIVE,
    seatAvail: 0,
    companyName: "Co",
    daysWorking: "1,1,1,1,1,0,0",
    startCoordLng: 0,
    startCoordLat: 0,
    companyCoordLng: 10,
    companyCoordLat: 10,
    ...overrides,
  }) as unknown as User;

const buildMember = (
  id: string,
  overrides: Partial<PublicUser> = {},
): PublicUser =>
  ({
    id,
    name: `${id} name`,
    preferredName: `${id} preferred`,
    pronouns: "",
    bio: "",
    role: Role.RIDER,
    status: Status.ACTIVE,
    seatAvail: 0,
    companyName: "Co",
    daysWorking: "1,1,1,1,1,0,0",
    startCoordLng: 1,
    startCoordLat: 1,
    companyCoordLng: 9,
    companyCoordLat: 9,
    ...overrides,
  }) as unknown as PublicUser;

const buildDriver = (overrides: Partial<PublicUser> = {}) =>
  buildMember(DRIVER_ID, { role: Role.DRIVER, ...overrides });

type RunArgs = Parameters<typeof runViewGroupRoute>[0];

const run = (overrides: Partial<RunArgs> = {}) => {
  const setPoints = jest.fn();

  runViewGroupRoute({
    user: buildUser(),
    driver: buildDriver(),
    riders: [buildMember(RIDER_ID)],
    map,
    setPoints,
    ...overrides,
  });

  return { setPoints };
};

/** The `updateCompanyLocation` calls that pin somebody other than the viewer. */
const otherPinCalls = () =>
  jest
    .mocked(updateCompanyLocation)
    .mock.calls.filter((call) => call[6] === false)
    .map((call) => ({ userId: call[4], label: call[8] }));

const startMarkerCalls = () =>
  jest
    .mocked(updateStartLocation)
    .mock.calls.map((call) => ({ userId: call[4], label: call[8] }));

/** The order in which a mock was first called, for ordering assertions. */
const firstCallOrder = (fn: unknown) =>
  jest.mocked(fn as jest.Mock).mock.invocationCallOrder[0];

beforeEach(() => {
  jest.clearAllMocks();
  // The guard below logs deliberately; matching `viewRouteClick.test.ts` so a
  // passing run stays readable.
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("runViewGroupRoute", () => {
  describe("clearing the previous preview", () => {
    it("sweeps every other user's pin", () => {
      // The fix. Before it, the only cleanup here was `clearMarkers`, which
      // swept `-text-layer` and nothing else - so the previous preview's
      // destination pins stayed, unlabelled, under the new one.
      run();

      expect(clearOtherUserMarkers).toHaveBeenCalledWith(map);
      expect(clearOtherUserMarkers).toHaveBeenCalledTimes(1);
    });

    it("clears the route line and the popup markers too", () => {
      run();

      expect(clearDirections).toHaveBeenCalledWith(map);
      expect(clearMarkers).toHaveBeenCalledWith(map);
    });

    it("sweeps before drawing, never after", () => {
      // The acceptance criterion a later edit is most likely to break: this
      // handler must not clear the markers it just drew. Asserted on
      // invocation order, because both orderings read as cleanup.
      run();

      const swept = firstCallOrder(clearOtherUserMarkers)!;

      expect(swept).toBeLessThan(firstCallOrder(updateCompanyLocation)!);
      expect(swept).toBeLessThan(firstCallOrder(updateStartLocation)!);
      expect(swept).toBeLessThan(firstCallOrder(updateUserLocation)!);
    });

    it("leaves its own pins standing", () => {
      // The whole-behaviour statement of the one above: after the call, every
      // member still has a pin. A sweep in the wrong place would show up as an
      // empty list here rather than as an ordering detail.
      run();

      expect(otherPinCalls().map((call) => call.userId)).toEqual([
        DRIVER_ID,
        RIDER_ID,
      ]);
    });
  });

  describe("the members' markers", () => {
    it("pins the driver and every rider, labelled", () => {
      run();

      expect(otherPinCalls()).toEqual([
        { userId: DRIVER_ID, label: "driver-id preferred Dest." },
        { userId: RIDER_ID, label: "rider-id preferred Dest." },
      ]);
      expect(startMarkerCalls()).toEqual([
        { userId: DRIVER_ID, label: "driver-id preferred Start" },
        { userId: RIDER_ID, label: "rider-id preferred Start" },
      ]);
    });

    it("skips the viewer when they are the driver", () => {
      // They already have `current-user-*` markers, in the colours that mark
      // them as you rather than as somebody you are looking at.
      run({ driver: buildDriver({ id: VIEWER_ID }) });

      expect(otherPinCalls().map((call) => call.userId)).toEqual([RIDER_ID]);
    });

    it("skips the viewer when they are a rider", () => {
      run({
        riders: [buildMember(VIEWER_ID), buildMember(RIDER_ID)],
      });

      expect(otherPinCalls().map((call) => call.userId)).toEqual([
        DRIVER_ID,
        RIDER_ID,
      ]);
    });

    it("falls back to a name, then to a positional label", () => {
      run({
        driver: buildDriver({ preferredName: "", name: "Driver Name" }),
        riders: [
          buildMember(RIDER_ID, { preferredName: "", name: "" }),
          buildMember("r2", { preferredName: "", name: "" }),
        ],
      });

      expect(otherPinCalls().map((call) => call.label)).toEqual([
        "Driver Name Dest.",
        "Rider 1 Dest.",
        "Rider 2 Dest.",
      ]);
    });
  });

  describe("the viewer's own markers", () => {
    it("are drawn for a rider or driver", () => {
      run();

      expect(updateUserLocation).toHaveBeenCalledTimes(1);
      expect(
        jest
          .mocked(updateCompanyLocation)
          .mock.calls.filter((call) => call[6] === true),
      ).toHaveLength(1);
    });

    it("are skipped for a viewer, who has no coordinates of their own", () => {
      run({ user: buildUser({ role: Role.VIEWER }) });

      expect(updateUserLocation).not.toHaveBeenCalled();
      expect(
        jest
          .mocked(updateCompanyLocation)
          .mock.calls.filter((call) => call[6] === true),
      ).toHaveLength(0);
    });
  });

  describe("the route", () => {
    it("asks for directions through every member's corners", () => {
      const { setPoints } = run();

      expect(setPoints).toHaveBeenCalledTimes(1);
      expect(setPoints.mock.calls[0]![0]).toEqual([
        [1, 1],
        [1, 1],
        [9, 9],
        [9, 9],
      ]);
    });

    it("fits the map to the group", () => {
      run();

      expect(fitBounds).toHaveBeenCalledTimes(1);
    });
  });

  describe("guards", () => {
    it("does nothing without a map", () => {
      const { setPoints } = run({ map: undefined });

      expect(setPoints).not.toHaveBeenCalled();
      expect(clearOtherUserMarkers).not.toHaveBeenCalled();
      expect(updateCompanyLocation).not.toHaveBeenCalled();
    });

    it("draws a driver-only group", () => {
      const { setPoints } = run({ riders: [] });

      expect(setPoints).toHaveBeenCalledTimes(1);
      expect(otherPinCalls().map((call) => call.userId)).toEqual([DRIVER_ID]);
    });
  });
});
