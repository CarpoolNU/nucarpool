import { planViewRoute } from "./viewRoutePlan";

const CLICKED = "clicked-user-id";
const OTHER = "some-other-user-id";

const plan = (overrides: Partial<Parameters<typeof planViewRoute>[0]> = {}) =>
  planViewRoute({
    clickedUserId: CLICKED,
    selectedUserId: null,
    isClickedUserOnMap: false,
    markedDestinationUserId: null,
    ...overrides,
  });

/**
 * Every combination of the two inputs that used to decide whether a route got
 * drawn, with the plan each one should produce. Named so a failure says which
 * combination, because "the fourth case" is exactly how this defect hid.
 *
 * Whether the route is *drawn* is asserted in `viewRouteClick.test.ts`, at the
 * call itself - there is no plan field for it. This table pins the other half:
 * the pin and the selection.
 */
const COMBINATIONS = [
  {
    name: "on the map, and the open conversation is theirs",
    isClickedUserOnMap: true,
    selectedUserId: CLICKED,
    isInRequestContext: true,
    selectsClickedUser: false,
    addsDestinationMarker: true,
  },
  {
    name: "on the map, with no conversation open",
    isClickedUserOnMap: true,
    selectedUserId: null,
    isInRequestContext: false,
    selectsClickedUser: true,
    addsDestinationMarker: false,
  },
  {
    name: "off the map, and the open conversation is theirs",
    isClickedUserOnMap: false,
    selectedUserId: CLICKED,
    isInRequestContext: true,
    selectsClickedUser: false,
    addsDestinationMarker: true,
  },
  {
    name: "off the map, with no conversation open",
    isClickedUserOnMap: false,
    selectedUserId: null,
    isInRequestContext: false,
    selectsClickedUser: true,
    // The fix. This was the click that returned before drawing anything.
    addsDestinationMarker: true,
  },
] as const;

describe("planViewRoute", () => {
  describe("every combination of the two inputs", () => {
    it.each(COMBINATIONS)(
      "$name",
      ({ name, isClickedUserOnMap, selectedUserId, ...outcome }) => {
        expect(plan({ isClickedUserOnMap, selectedUserId })).toMatchObject(
          outcome,
        );
      },
    );

    // The regression proper: a favourite the discovery query filtered off the
    // map is the click that used to do nothing at all.
    it("gives an off-map favourite a pin and a selection", () => {
      expect(
        plan({ isClickedUserOnMap: false, selectedUserId: null }),
      ).toMatchObject({
        isInRequestContext: false,
        selectsClickedUser: true,
        addsDestinationMarker: true,
      });
    });

    it("does the same for a Requests card pressed with another conversation open", () => {
      expect(
        plan({ isClickedUserOnMap: false, selectedUserId: OTHER }),
      ).toMatchObject({
        isInRequestContext: false,
        addsDestinationMarker: true,
      });
    });
  });

  describe("request context", () => {
    it("is the click MessagePanel's Map tab makes", () => {
      expect(plan({ selectedUserId: CLICKED }).isInRequestContext).toBe(true);
    });

    it("leaves the page's otherUser state alone", () => {
      expect(plan({ selectedUserId: CLICKED }).selectsClickedUser).toBe(false);
    });

    it("points otherUser at the clicked user everywhere else", () => {
      expect(plan({ selectedUserId: OTHER }).selectsClickedUser).toBe(true);
      expect(plan({ selectedUserId: null }).selectsClickedUser).toBe(true);
    });

    it("is not entered by a cleared selection matching a blank id", () => {
      // Defends the truthiness check rather than a reachable state: cuids are
      // never empty, so this pair cannot occur today. It is what stops a
      // cleared selection from being read as a match if one ever could.
      expect(
        plan({ clickedUserId: "", selectedUserId: "" }).isInRequestContext,
      ).toBe(false);
    });

    it("is not entered by a cleared selection", () => {
      // `handleUserSelect("")` is how the sidebar clears one, so the empty
      // string is a value this really receives. Compared for truthiness for
      // that reason, matching the original `selectedUserId && ...`.
      expect(plan({ selectedUserId: "" }).isInRequestContext).toBe(false);
    });

    /**
     * The defect itself, stated as an invariant.
     *
     * The unreachable branch sat inside `if (!isInRequestContext)` and asked
     * for `selectedUserId === clickedUser.id` - the very thing that makes
     * `isInRequestContext` true. Any future condition of that shape is dead on
     * arrival, so pin the implication rather than the old branch: outside
     * request context, the ids never match.
     */
    it("never reports a matching selection outside request context", () => {
      const inputs: (string | null)[] = [null, "", OTHER, CLICKED];

      for (const selectedUserId of inputs) {
        for (const isClickedUserOnMap of [true, false]) {
          const result = plan({ selectedUserId, isClickedUserOnMap });

          if (!result.isInRequestContext) {
            expect(selectedUserId === CLICKED).toBe(false);
          }
        }
      }
    });
  });

  describe("destination pin", () => {
    it("is added for a user the map is not plotting", () => {
      expect(plan({ isClickedUserOnMap: false }).addsDestinationMarker).toBe(
        true,
      );
    });

    it("is not added for a user the cluster layer already draws", () => {
      expect(plan({ isClickedUserOnMap: true }).addsDestinationMarker).toBe(
        false,
      );
    });

    it("is added in request context even for a user on the map", () => {
      // Deliberately asymmetric - this is what the working path did before
      // SCRUM-379, and MessagePanel's Map tab is the regression to protect.
      expect(
        plan({ isClickedUserOnMap: true, selectedUserId: CLICKED })
          .addsDestinationMarker,
      ).toBe(true);
    });
  });

  describe("removing the pin left over from a previous click", () => {
    it("removes nothing when no pin is remembered", () => {
      expect(plan().removesDestinationMarkerFor).toBeNull();
    });

    it("removes another user's pin", () => {
      expect(
        plan({ markedDestinationUserId: OTHER }).removesDestinationMarkerFor,
      ).toBe(OTHER);
    });

    it("keeps the pin when the same user is clicked again", () => {
      expect(
        plan({ markedDestinationUserId: CLICKED, isClickedUserOnMap: false })
          .removesDestinationMarkerFor,
      ).toBeNull();
    });

    it("removes the remembered user's own pin once the map starts plotting them", () => {
      // What `isPrevOtherUserInGeoList` was reaching for: the pin is now a
      // duplicate of their cluster point, so it goes.
      expect(
        plan({ markedDestinationUserId: CLICKED, isClickedUserOnMap: true })
          .removesDestinationMarkerFor,
      ).toBe(CLICKED);
    });

    it("keeps a request-context pin on a re-click even when they are on the map", () => {
      expect(
        plan({
          markedDestinationUserId: CLICKED,
          isClickedUserOnMap: true,
          selectedUserId: CLICKED,
        }).removesDestinationMarkerFor,
      ).toBeNull();
    });

    it("never names the clicked user's pin for removal while also adding it", () => {
      for (const isClickedUserOnMap of [true, false]) {
        for (const selectedUserId of [null, "", OTHER, CLICKED]) {
          const result = plan({
            isClickedUserOnMap,
            selectedUserId,
            markedDestinationUserId: CLICKED,
          });

          if (result.addsDestinationMarker) {
            expect(result.removesDestinationMarkerFor).not.toBe(CLICKED);
          }
        }
      }
    });
  });
});
