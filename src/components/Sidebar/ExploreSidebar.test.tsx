import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import ExploreSidebar from "./ExploreSidebar";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, FiltersState, User } from "../../utils/types";
import { QueryState } from "../../utils/queryState";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * `ExploreSidebar`: which list controls a phone can reach, and which list the
 * component returns to once the connect flow closes.
 *
 * Two tickets, one per `describe` block, which were two sibling files. The
 * split was not one of the mandatory kinds in `CLAUDE.md` - the second file's
 * module mocks are simply wider, and the first block never reaches them,
 * because it provides no `UserContext` and so renders no cards. The second
 * block sets its own viewport and clears its own spy inside its own
 * `beforeEach`, which runs after the `describe.each` one below, so neither
 * block can disturb the other's width.
 *
 * ---
 *
 * Reachability of the Explore list controls at a mobile viewport.
 *
 * Three controls were wrapped in `!isMobile` with no mobile equivalent behind
 * them, so on a phone they did not exist:
 *
 *   - the Recommendations/Favorites switch, which holds the *only*
 *     `setCurOption("favorites")` call. Without it `curOption` was pinned to
 *     `"recommendations"` for the component's lifetime, so `props.favs` could
 *     never be rendered — while the favourite star on each card stayed
 *     ungated. Favouriting was a write with no matching read.
 *   - the sort control.
 *   - the filter button, which holds the only `setFiltersOpen(true)` call, and
 *     with it the sole route to all 617 lines of `Filters`.
 *
 * These assertions are the point of the ticket and they fail against the code
 * as it stood: each control was absent from the mobile tree entirely, so
 * `getByRole` finds nothing rather than finding something mis-styled. Every
 * test here therefore has a desktop counterpart, because "present on both" is
 * the actual requirement — a fix that moved a control from desktop-only to
 * mobile-only would satisfy half of it and pass a one-sided test.
 *
 * `ExploreSidebar` is renderable without a tRPC client or a router because
 * every list it shows arrives as a prop, and because `SidebarContent` returns
 * `null` without a `UserContext` — which is deliberately what these tests
 * leave unprovided. That confines the render to the header controls under test
 * and keeps the card tree, with its mutations and its profile-image queries,
 * out of it. `Filters` is likewise prop-driven, so opening the panel is
 * assertable too.
 */

const mockCreateRequest = jest.fn();

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: {
        recommendations: { me: { invalidate: jest.fn() } },
        requests: { me: { invalidate: jest.fn() } },
      },
    }),
    user: {
      favorites: { edit: { useMutation: () => ({ mutate: jest.fn() }) } },
      blocks: {
        block: { useMutation: () => ({ mutate: jest.fn(), isPending: false }) },
      },
      requests: {
        create: {
          useMutation: (options?: {
            onSuccess?: (request: { id: string }, variables: unknown) => void;
          }) => ({
            mutate: (variables: unknown) => {
              mockCreateRequest(variables);
              options?.onSuccess?.({ id: "request-1" }, variables);
            },
            isPending: false,
          }),
        },
      },
      emails: {
        sendRequestNotification: {
          useMutation: () => ({ mutate: jest.fn() }),
        },
      },
    },
  },
}));

jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

const BASE: FiltersState = {
  days: 0,
  flexDays: 1,
  startDistance: 20,
  endDistance: 20,
  daysWorking: "",
  startTime: 4,
  endTime: 4,
  startDate: new Date("2026-01-31T00:00:00.000Z"),
  endDate: new Date("2026-06-30T00:00:00.000Z"),
  dateOverlap: 0,
  favorites: false,
  messaged: false,
};

const READY: QueryState = { status: "ready", retry: () => undefined };

restoreViewportAfterEach();

const renderSidebar = (
  overrides: { disabled?: boolean; mobileSelectedUser?: string | null } = {},
) =>
  render(
    <ExploreSidebar
      recs={[]}
      favs={[]}
      recsState={READY}
      favsState={READY}
      setFilters={() => undefined}
      defaultFilters={BASE}
      setSort={() => undefined}
      sort="any"
      filters={BASE}
      disabled={overrides.disabled ?? false}
      viewRoute={() => undefined}
      onViewRequest={() => undefined}
      mobileSelectedUser={overrides.mobileSelectedUser ?? null}
      handleMobileExpand={() => undefined}
    />,
  );

describe.each([
  ["mobile", MOBILE_WIDTH],
  ["desktop", DESKTOP_WIDTH],
])("Explore list controls at %s width", (_label, width) => {
  beforeEach(() => {
    setViewportWidth(width);
  });

  it("offers both the Recommendations and the Favorites list", () => {
    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Recommendations" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Favorites" }),
    ).toBeInTheDocument();
  });

  it("switches to the Favorites list when that button is pressed", async () => {
    renderSidebar();

    // `curOption` is private to the component, so this asserts on its one
    // consequence that is visible without a `UserContext`: sort and filters are
    // gated on `curOption === "recommendations"`, so selecting Favorites must
    // withdraw them. Pressing the button and checking its own styling would
    // pass with the switch inert; this cannot, because with `curOption` pinned
    // the row could never disappear.
    expect(screen.getByRole("button", { name: /Sort by/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Favorites" }));

    expect(
      screen.queryByRole("button", { name: /Sort by/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open filters" }),
    ).not.toBeInTheDocument();
  });

  it("offers the sort control", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: /Sort by/ })).toBeInTheDocument();
  });

  /**
   * The two list-switch buttons signalled the active list by colour alone -
   * no `aria-pressed` - so both announced identically.
   */
  it("marks exactly the active list as pressed", async () => {
    renderSidebar();

    expect(
      screen.getByRole("button", { name: "Recommendations" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: "Favorites" }));

    expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("opens the filter panel from the filter button", async () => {
    renderSidebar();

    await userEvent.click(screen.getByRole("button", { name: "Open filters" }));

    expect(
      screen.getByRole("heading", { name: "Filters" }),
    ).toBeInTheDocument();
  });

  it("withholds sort and filters from a VIEWER, who cannot act on results", () => {
    renderSidebar({ disabled: true });

    // Not a viewport rule — a VIEWER has nothing to narrow. The switch stays,
    // because a VIEWER can still have favourites.
    expect(
      screen.queryByRole("button", { name: "Open filters" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sort by/ }),
    ).not.toBeInTheDocument();
  });
});

describe("the mobile detail state", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  /**
   * `mobileSelectedUser` is the one case where the list controls are correctly
   * absent: `index.tsx` shrinks the sheet and `SidebarContent` filters the
   * list to the single selected card, so a list switch and a sort control have
   * nothing to act on and would crowd out the card above them.
   */
  it("hides the list controls while a single card is expanded", () => {
    renderSidebar({ mobileSelectedUser: "some-user-id" });

    expect(
      screen.queryByRole("button", { name: "Favorites" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open filters" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Sort by/ }),
    ).not.toBeInTheDocument();
  });

  it("restores them once no card is expanded", () => {
    renderSidebar({ mobileSelectedUser: null });

    expect(
      screen.getByRole("button", { name: "Favorites" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open filters" }),
    ).toBeInTheDocument();
  });

  /*
   * A third test stood here once, named "keeps the controls at
   * desktop width even with a stale expanded card". It rendered this component
   * at a desktop width with `mobileSelectedUser` set and asserted the controls
   * survived, pinning the `isMobile` term the gate carried for exactly that
   * reason.
   *
   * It is gone because the premise is gone, not because the behaviour stopped
   * mattering. `index.tsx` derives the prop through
   * `resolveMobileSelectedUser`, so a desktop render cannot receive a non-null
   * value any more - the test's own setup is now unreachable, and it would
   * fail, correctly, against the simplified gate. Replacing it with a version
   * that expects the controls to *disappear* would only be asserting that this
   * component obeys its props.
   *
   * The invariant it used to defend locally is enforced at the source and
   * tested in `utils/explore/exploreSidebarView.test.ts`.
   */
});

/**
 * A successfully-sent connect request did not return mobile Explore to the
 * Recommendations tab. `curOption` lived only in
 * `ExploreSidebar`, and `SidebarContent.renderUserCard` never passed an
 * `onClose` into the `ConnectCard`s it builds for the Recommendations and
 * Favorites tabs - so nothing downstream of `ConnectModal` could reach it.
 *
 * The proxy used below is deliberate: `curOption` is private to
 * `ExploreSidebar`, so these tests distinguish "reset" from "not reset" by
 * which list backs the still-expanded mobile detail card. `favs` carries the
 * user being connected with; `recs` is empty. A reset to `"recommendations"`
 * therefore makes that person's card disappear - the list it is filtered from
 * became empty - which a real assertion on internal state could not fake.
 */
describe("Explore tab after the connect flow closes", () => {
  const OTHER_USER = {
    id: "other-1",
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
    isFavorited: true,
  } as unknown as EnhancedPublicUser;

  const VIEWER = {
    id: "viewer-1",
    role: Role.RIDER,
    status: Status.ACTIVE,
    seatAvail: 0,
  } as unknown as User;

  const BASE: FiltersState = {
    days: 0,
    flexDays: 1,
    startDistance: 20,
    endDistance: 20,
    daysWorking: "",
    startTime: 4,
    endTime: 4,
    startDate: new Date("2026-01-31T00:00:00.000Z"),
    endDate: new Date("2026-06-30T00:00:00.000Z"),
    dateOverlap: 0,
    favorites: false,
    messaged: false,
  };

  const READY: QueryState = { status: "ready", retry: () => undefined };

  /**
   * `mobileSelectedUser` is owned by `index.tsx` in the real app, so it has to
   * be a controlled prop here too - this harness is the smallest stand-in for
   * that state, not a stand-in for the fix under test.
   */
  const Harness = () => {
    const [mobileSelectedUser, setMobileSelectedUser] = useState<string | null>(
      null,
    );
    return (
      <UserContext.Provider value={VIEWER}>
        <ExploreSidebar
          recs={[]}
          favs={[OTHER_USER]}
          recsState={READY}
          favsState={READY}
          setFilters={() => undefined}
          defaultFilters={BASE}
          setSort={() => undefined}
          sort="any"
          filters={BASE}
          disabled={false}
          viewRoute={() => undefined}
          onViewRequest={() => undefined}
          mobileSelectedUser={mobileSelectedUser}
          handleMobileExpand={(userId) => setMobileSelectedUser(userId ?? null)}
        />
      </UserContext.Provider>
    );
  };

  const openConnectModalFromFavorites = async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole("button", { name: "Favorites" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Show Riley's full details" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect!" }));
  };

  beforeEach(() => {
    mockCreateRequest.mockClear();
    setViewportWidth(MOBILE_WIDTH);
  });

  it("returns to Recommendations once a request sent from Favorites is closed", async () => {
    await openConnectModalFromFavorites();

    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(
      screen.getByRole("heading", { name: "Your request has been sent!" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    // Still filtered to Riley's card by `mobileSelectedUser`, but the list it
    // is drawn from switched to the empty `recs` - proof `curOption` reset.
    expect(screen.queryByText("Riley")).not.toBeInTheDocument();
    expect(
      screen.getByText(/unable to find any recommendations/i),
    ).toBeInTheDocument();
  });

  it("leaves Favorites active when the modal is cancelled before sending", async () => {
    await openConnectModalFromFavorites();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockCreateRequest).not.toHaveBeenCalled();
    // Unaffected: Riley's card, from `favs`, is still the one on screen.
    expect(screen.getByText("Riley")).toBeInTheDocument();
  });
});
