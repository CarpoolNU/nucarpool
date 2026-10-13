import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Role, Status } from "@prisma/client";
import Header from "./Header";
import { resetTrpcSpies } from "../testing/trpcHarness";
import { UserContext } from "../utils/userContext";
import { User } from "../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../testing/viewport";
import { routerSpies } from "../testing/nextRouterStub";
import { showsInactiveBlocker } from "../utils/map/inactiveBlocker";

/**
 * What the header lets an inactive rider or driver do, at both viewports.
 *
 * One rule, and this file is where both halves of it are asserted against the
 * real component: **while the inactive blocker is up the map tabs go dead and
 * the route to the profile stays live.** `nav/mobileNavPlan.test.ts` proves the
 * rule itself; this proves the component is wired to it, which is a separate
 * fact and the one that was false. `disabled` was declared on `data`, passed
 * from both of `index.tsx`'s render sites and read only by the desktop tab
 * row, so on a phone an inactive user could walk between Explore, Requests and
 * My Group behind a modal telling them they could not continue. SCRUM-669.
 *
 * **The desktop half is a regression guard with nothing behind it before now.**
 * Every other `Header` suite passes `disabled: false`, so no test anywhere
 * exercised the desktop tabs in their disabled state - the behaviour the
 * ticket called "existing" was real but unguarded, and the mobile fix is
 * worth little if the desktop side can silently stop matching it.
 *
 * **Why `showsInactiveBlocker` is called here rather than a boolean written
 * in.** `data.disabled` is a prop, so a test could set it to `true` directly
 * and never touch the question of what makes a user inactive. Computing it the
 * way `pages/index.tsx` does means the user in `UserContext` is what drives
 * the assertion, so the VIEWER exemption and the INACTIVE test are the real
 * ones rather than restated here - and a change to the predicate that stopped
 * covering a role would surface as a failure in this file too.
 *
 * *What this does not cover:* the greying itself is `opacity`, and whether it
 * reads as disabled to a person is not something jsdom can answer. It does no
 * layout and paints nothing - see `testing/viewport.ts`. What is asserted here
 * is the attribute and the absence of navigation, which is the behaviour.
 */

/**
 * `pathname` is `/` because that is the only route supplying `data`, and so
 * the only one with a blocker to honour. `query` must be present rather than
 * merely absent: `Header` destructures `tab` out of it during render.
 */
jest.mock("next/router", () =>
  require("../testing/nextRouterStub").buildRouterMock({
    pathname: "/",
    query: {},
  }),
);

const mockPush = routerSpies().push;

/**
 * The same two queries `Header.test.tsx` stands in for, and for the same
 * reasons: the unread count feeds the Requests badge, and the presigned URL
 * sits behind `DropDownMenu`'s avatar. Neither is this file's subject, and a
 * `{ url: null }` resolution rather than `undefined` keeps React Query from
 * treating the result as an error.
 */
jest.mock("../utils/trpc", () =>
  require("../testing/trpcHarness").buildTrpcMock(
    {
      "user.messages.getUnreadMessageCount": { inertQuery: true },
      "user.getPresignedDownloadUrl": { query: async () => ({ url: null }) },
    },
    { realTimeQueryOptions: {} },
  ),
);

/** Subscribes to Pusher for live invalidation; no side effects wanted here. */
jest.mock("../utils/messages/useUnreadNotifications", () => ({
  useUnreadNotifications: () => undefined,
}));

/**
 * `DropDownMenu` calls `useSession`. Left unauthenticated deliberately: that
 * leaves `Menu.Items` unrendered, so the menu's own Profile button is out of
 * the DOM and the assertion below is about the trigger. The trigger is the
 * right subject anyway - it is the control `disabled` would have to reach to
 * close the desktop route to the profile, and it renders at every session
 * state.
 */
jest.mock("next-auth/react", () =>
  require("../testing/nextAuthStub").buildNextAuthMock({
    status: "unauthenticated",
  }),
);

restoreViewportAfterEach();

beforeEach(() => {
  resetTrpcSpies();
  mockPush.mockClear();
});

/** An inactive rider: the role and status pairing the blocker exists for. */
const INACTIVE_RIDER = {
  id: "rider-1",
  role: Role.RIDER,
  status: Status.INACTIVE,
  permission: "USER",
  preferredName: "Sam",
} as unknown as User;

const ACTIVE_RIDER = {
  ...INACTIVE_RIDER,
  status: Status.ACTIVE,
} as unknown as User;

/**
 * An inactive VIEWER, which the blocker has never applied to - the role
 * browses and cannot connect, so there is nothing to be inactive from. Here to
 * prove the exemption survives the whole composition, not just the predicate.
 */
const INACTIVE_VIEWER = {
  ...INACTIVE_RIDER,
  role: Role.VIEWER,
} as unknown as User;

/** An inactive manager, so the desktop Admin tab renders and can be checked. */
const INACTIVE_MANAGER = {
  ...INACTIVE_RIDER,
  permission: "MANAGER",
} as unknown as User;

/**
 * A fresh `QueryClient` per render, for the reason `Header.test.tsx` gives:
 * `useProfileImage` sets a long `staleTime`, so a shared client would serve a
 * previous test's cached value and make results depend on test order.
 */
const renderHeader = (user: User) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UserContext.Provider value={user}>
        <Header
          data={{
            sidebarValue: "explore",
            setSidebar: () => undefined,
            // Computed, not asserted - see the file docblock.
            disabled: showsInactiveBlocker(user),
          }}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>
    </QueryClientProvider>,
  );

/** The three map tabs on the mobile bar, by the testids the component assigns. */
const MOBILE_TABS = [
  "explore-sidebar",
  "requests-sidebar",
  "mygroup-sidebar",
] as const;

const mobileItem = (testId: string) => screen.getByTestId(testId);

describe("the mobile bar while the inactive blocker is up", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it.each(MOBILE_TABS)("disables %s", (testId) => {
    renderHeader(INACTIVE_RIDER);

    expect(mobileItem(testId)).toBeDisabled();
  });

  it("leaves Profile live, which is the only way to clear the status", () => {
    renderHeader(INACTIVE_RIDER);

    // The positive half of the rule, and not a formality: this is what stops
    // the fix stranding an inactive user with the blocker's own button as
    // their single exit.
    expect(mobileItem("profile-sidebar")).toBeEnabled();
  });

  it("does not navigate when a disabled tab is pressed", () => {
    // The attribute could be set and the item still act, if the component
    // ever stopped using the native one and only greyed the icon. A click
    // that reaches `handleMobileNavClick` calls `router.push`, so an unmoved
    // spy is the behaviour rather than the markup.
    renderHeader(INACTIVE_RIDER);

    for (const testId of MOBILE_TABS) {
      fireEvent.click(mobileItem(testId));
    }

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("still navigates when Profile is pressed", async () => {
    // The positive control for the assertion above. Without it, a header that
    // had stopped navigating on every tab would pass that test too.
    renderHeader(INACTIVE_RIDER);

    // `await act`, not a bare `fireEvent`: the handler lowers its spinner in
    // the push promise's `finally`, which settles after the click returns. An
    // unawaited state update here logs an act() warning naming whichever test
    // runs next, which is how a leak like this gets misattributed.
    await act(async () => {
      fireEvent.click(mobileItem("profile-sidebar"));
    });

    expect(mockPush).toHaveBeenCalledWith("/profile");
  });
});

describe("the mobile bar when there is no blocker", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("leaves every item live for an active rider", () => {
    renderHeader(ACTIVE_RIDER);

    for (const testId of [...MOBILE_TABS, "profile-sidebar"]) {
      expect(mobileItem(testId)).toBeEnabled();
    }
  });

  it("leaves every item live for an inactive VIEWER", () => {
    // The role is exempt at either status, so an INACTIVE VIEWER must reach
    // every tab. Production holds 38 such rows, so this is a real combination
    // rather than a constructed one.
    renderHeader(INACTIVE_VIEWER);

    for (const testId of [...MOBILE_TABS, "profile-sidebar"]) {
      expect(mobileItem(testId)).toBeEnabled();
    }
  });
});

describe("the desktop tab row while the inactive blocker is up", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it.each(["Explore", "Requests", "My Group"])("disables %s", (name) => {
    renderHeader(INACTIVE_RIDER);

    expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("disables Admin for the permission that renders it", () => {
    // The tab only renders for a non-USER permission, so the default rider
    // above cannot cover it and its guard would otherwise go unasserted.
    renderHeader(INACTIVE_MANAGER);

    expect(screen.getByRole("button", { name: "Admin" })).toBeDisabled();
  });

  it.each(["Explore", "Requests", "My Group"])(
    "gives %s the disabled variant that greys it",
    (name) => {
      // The desktop half of the affordance the mobile bar already had, which
      // is what made a dead tab indistinguishable from a broken one. SCRUM-673.
      //
      // **The utility is unconditional and that is the point**, so this is not
      // the usual "present when disabled" assertion and has no "absent when
      // enabled" twin - the active rider below carries the same class. The
      // variant lives on the class and the browser applies it only while the
      // native attribute is set, which is what keeps `renderClassName` from
      // having to learn about the state and stops the two drifting apart. What
      // this guards is that the constant still carries it and still reaches
      // the button; the attribute that fires it is guarded above.
      //
      // jsdom resolves no CSS, so nothing here proves a greyer tab. Measured
      // in Chromium against the compiled stylesheet instead: 0.4 disabled
      // against 1 live, the figure `MobileNavItem` uses.
      renderHeader(INACTIVE_RIDER);

      expect(screen.getByRole("button", { name })).toHaveClass(
        "disabled:opacity-40",
      );
    },
  );

  it("leaves the profile dropdown's trigger live", () => {
    renderHeader(INACTIVE_RIDER);

    // `DropDownMenu` renders outside `renderSidebarOptions` and is handed no
    // `disabled`, which is what makes the desktop rule "the tabs, not the
    // route to the profile" - the half the mobile bar now matches. Asserted
    // rather than assumed, because moving the menu inside the gated element
    // would close that route and break the agreement without touching a
    // single tab.
    //
    // Selected by `expanded` rather than by name: `Menu.Button`'s only child
    // is `ProfileAvatar`, whose placeholder and fallback are both bare divs,
    // so the `alt` text reaches the DOM only when a real image loads and the
    // trigger has no accessible name here at all. The filter matches
    // `aria-expanded="false"`, which Headless UI puts on the closed trigger
    // and nothing else in the desktop header carries. The missing name is a
    // defect in its own right - SCRUM-672 - and this suite works around it
    // rather than asserting it. When that is fixed, select by name here and
    // drop this note.
    expect(screen.getByRole("button", { expanded: false })).toBeEnabled();
  });

  it("leaves every tab live for an active rider", () => {
    // The control the suite had none of: without it, a header that disabled
    // its tabs unconditionally would satisfy every assertion above.
    renderHeader(ACTIVE_RIDER);

    for (const name of ["Explore", "Requests", "My Group"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  });
});
