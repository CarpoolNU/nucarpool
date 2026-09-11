import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import { MapConnectPortal } from "./MapConnectPortal";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * What a map pin tap opens, and whether it can be closed again.
 *
 * This assertion was written earlier and deferred to this
 * ticket, because the capability did not exist to test: `MapConnectPortal` was
 * `!isMobile`-gated in `index.tsx` while the map's click handlers ran on every
 * platform, so a phone tap set `popupUsers` and nothing rendered - and nothing
 * could clear it again, for the rest of the session. A test for a capability
 * that does not exist is a failing test rather than a guard, so phase 5 left
 * it here.
 *
 * The dismissal half is the point. "Something renders" was never the whole
 * defect: the state being unclearable was the worse half, and it is the half a
 * presence assertion misses entirely.
 *
 * Measured against the pre-fix component, **two of these seven fail** - the two
 * about the close control. The rest pass either way, and the first test's own
 * comment explains why that is expected rather than a gap in the assertions.
 *
 * *Not covered, and not coverable here:* that the sheet clears the bottom
 * navigation, that its height is reasonable, or that it sits above the
 * navigation's `z-index: 100`. jsdom does no layout and computes no stacking -
 * see `src/testing/viewport.ts`. The positioning is arithmetic from that change's
 * tokens, not a measurement, and wants a look on a real phone.
 */

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: { recommendations: { me: { invalidate: jest.fn() } } },
    }),
    user: {
      favorites: { edit: { useMutation: () => ({ mutate: jest.fn() }) } },
    },
  },
}));

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

restoreViewportAfterEach();

const PIN_USER = {
  id: "pin-1",
  name: "Riley Other",
  preferredName: "Riley",
  pronouns: "they/them",
  bio: "",
  image: null,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  startAddress: "1 Somewhere St",
  startCoordLng: -71.09,
  startCoordLat: 42.34,
  companyAddress: "2 Elsewhere Ave",
  companyCoordLng: -71.08,
  companyCoordLat: 42.35,
  daysWorking: "1,1,1,1,1,0,0",
  startTime: new Date("2026-01-05T13:00:00.000Z"),
  endTime: new Date("2026-01-05T22:00:00.000Z"),
  coopStartDate: new Date("2026-01-05T00:00:00.000Z"),
  coopEndDate: new Date("2026-06-30T00:00:00.000Z"),
  carpoolId: null,
  isFavorited: false,
} as unknown as PublicUser;

/** A RIDER viewer, so a DRIVER pin is compatible and no notice renders. */
const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
} as unknown as User;

const renderPortal = (
  overrides: { otherUsers?: PublicUser[] | null; onClose?: () => void } = {},
) => {
  const onClose = overrides.onClose ?? jest.fn();

  render(
    <UserContext.Provider value={VIEWER}>
      <MapConnectPortal
        otherUsers={
          overrides.otherUsers === undefined ? [PIN_USER] : overrides.otherUsers
        }
        extendUser={(user) => user as EnhancedPublicUser}
        onViewRouteClick={() => undefined}
        onViewRequest={() => undefined}
        onClose={onClose}
      />
    </UserContext.Provider>,
  );

  return { onClose };
};

describe("a map pin tap at a mobile viewport", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("opens something showing the tapped user", () => {
    /*
     * **This one passes before the fix as well, and saying so matters.** The
     * defect was the `!isMobile` gate in `index.tsx`; this suite renders the
     * component directly, so it never sees that gate. The old component had no
     * viewport logic at all and rendered its cards whenever it was given any,
     * so of course it satisfies this.
     *
     * What is genuinely covered below is the component's half of the contract -
     * that a mobile render carries a control able to clear the selection - and
     * that is what could regress. The gate's removal is verified by reading the
     * diff, because `index.tsx` has no test: it is ~1300 lines behind Mapbox,
     * NextAuth and a dozen tRPC queries, which is the same reason earlier work
     * had for lifting decisions out of it. There is no decision left here to
     * lift - the answer is now "always render" - so there is nothing to make
     * pure and test.
     */
    renderPortal();

    expect(screen.getByText("Riley")).toBeInTheDocument();
  });

  it("offers a control that dismisses it", () => {
    renderPortal();

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("clears the pin selection when that control is used", async () => {
    // The half that matters. `onClose` is the page's `setPopupUsers(null)`, so
    // this is the assertion that the stuck-state defect is actually gone - a
    // sheet that rendered but could not call this would leave `popupUsers`
    // non-null exactly as before.
    const { onClose } = renderPortal();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays shut when no pin is selected", () => {
    // Guards the other direction: a sheet keyed off the wrong condition would
    // sit open over the map permanently.
    renderPortal({ otherUsers: null });

    expect(screen.queryByText("Riley")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });

  it("stays shut for an empty selection, not just a null one", () => {
    // `popupUsers` is `PublicUser[] | null`, so an empty array is reachable
    // and is not the same value as null.
    renderPortal({ otherUsers: [] });

    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });
});

describe("a map pin click at a desktop viewport", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("still opens showing the clicked user", () => {
    // Passes before and after. Desktop was never the broken side, and this is
    // what says the mobile branch did not cost it anything.
    renderPortal();

    expect(screen.getByText("Riley")).toBeInTheDocument();
  });

  it("adds no close button, so the desktop tab order is unchanged", () => {
    // Deliberate rather than an omission. `Dialog` already gives desktop
    // backdrop-click and Escape, and the ticket's criterion is that no desktop
    // behaviour changes - an extra focusable control in the panel would be
    // one. This is also why the branch is `useIsMobile` and not a breakpoint
    // utility: a control hidden by CSS would still be in the tree, and this
    // assertion would pass while the tab order had in fact changed.
    renderPortal();

    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });
});
