import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExploreSidebar from "./ExploreSidebar";
import { FiltersState } from "../../utils/types";
import { QueryState } from "../../utils/queryState";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
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
   * A third test stood here until SCRUM-418, named "keeps the controls at
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
