/**
 * What tapping an item in the mobile bottom navigation should do.
 *
 * `handleMobileNavClick` decided this inline, and one of the cases it decided
 * was wrong: leaving the profile page went straight to
 * `window.location.href`, tearing the page down along with every unsaved form
 * value. `checkChanges` — the unsaved-changes guard the profile page hands to
 * `Header` — was consulted by the desktop map button and by nothing else, so
 * `UnsavedModal` could not appear on mobile at all.
 *
 * The decision is lifted out here for the same reason `viewRoutePlan.ts` was:
 * `Header` cannot be executed without a router, a tRPC client, a portal and a
 * `GroupPage`, so a rule living inside it is a rule nothing checks. This is
 * the established shape — a plan that decides, and a caller that
 * carries it out.
 *
 * **The hard navigation is kept deliberately.** It fixed "can't switch
 * from profile to explore/requests on a real phone despite that it works on a
 * simulator" by replacing a client-side push with a full page load, and that
 * is load-bearing on real devices. A full load does defeat any client-side
 * guard — but only if it happens first. Asking the page *before* navigating
 * costs the guard nothing and leaves that change's behaviour untouched, which is
 * why no `beforeunload` fallback is needed.
 */

/** The three destinations the bottom navigation can reach besides the profile. */
export type NavTab = "explore" | "requests" | "mygroup";

const NAV_TABS: readonly NavTab[] = ["explore", "requests", "mygroup"];

export const isNavTab = (option: string): option is NavTab =>
  (NAV_TABS as readonly string[]).includes(option);

/**
 * The href a full page load uses to leave the profile page.
 *
 * `?tab=` is read back by `Header`'s own `useEffect` on the destination page,
 * which is why the tab has to survive in the URL rather than in React state:
 * nothing survives a full load.
 */
export const tabHref = (tab: NavTab): string => `/?tab=${tab}`;

export type MobileNavPlan =
  /** Ask the page's unsaved-changes guard first; it navigates when ready. */
  | { kind: "guard"; href: string; tab: NavTab }
  /** Leave the profile page with a full page load. */
  | { kind: "hardNavigate"; href: string; tab: NavTab }
  /** Client-side tab switch, staying on the map page. */
  | { kind: "switchTab"; tab: NavTab }
  /** Go to the profile page. */
  | { kind: "openProfile" }
  /** An option the bottom navigation does not handle. */
  | { kind: "ignore" };

/**
 * @param option the tapped item's id
 * @param pathname the current route, to tell whether the profile page is being
 *   left — the same `router.pathname` test the inline version used
 * @param hasUnsavedGuard whether a `checkChanges` prop was supplied. Only the
 *   profile page supplies one; the map and admin pages do not, and must keep
 *   navigating immediately.
 */
export function planMobileNav({
  option,
  pathname,
  hasUnsavedGuard,
}: {
  option: string;
  pathname: string;
  hasUnsavedGuard: boolean;
}): MobileNavPlan {
  if (option === "profile") {
    return { kind: "openProfile" };
  }

  if (!isNavTab(option)) {
    return { kind: "ignore" };
  }

  // Not on the profile page, so there is nothing to lose and no full load
  // needed: the map page swaps its sidebar in place.
  if (!pathname.includes("/profile")) {
    return { kind: "switchTab", tab: option };
  }

  const href = tabHref(option);

  return hasUnsavedGuard
    ? { kind: "guard", href, tab: option }
    : { kind: "hardNavigate", href, tab: option };
}

/**
 * Which bottom-navigation item should be lit, or `null` when the current page
 * is not one of them.
 *
 * Split out here for the same reason `planMobileNav` is: this used to be an
 * inline ternary inside `renderMobileNav`, and one of its cases was wrong.
 * `/admin` supplies no `data`, so the highlight fell through to `activeNav` —
 * whose initial value is `"explore"` — and the bar claimed the user was on the
 * map while they were looking at the admin dashboard. There is no fourth tab
 * for `/admin` and there should not be one, so the honest answer is that none
 * of them is current.
 *
 * `null` rather than a tab is therefore load-bearing: it is what lets the bar
 * render with nothing selected, which is a state the ternary could not express.
 */
export type ActiveNavItem = NavTab | "profile" | null;

/**
 * @param pathname the current route. `includes` rather than equality, matching
 *   `planMobileNav` — `/profile/setup` is the profile page.
 * @param isAdmin the admin page's own `admin` prop. Taken from the caller
 *   rather than sniffed off `pathname` because the page states it directly,
 *   and a header told it is the admin header should agree with itself whatever
 *   route it is mounted on.
 * @param displayGroup whether the group modal is open, which the bar reflects
 *   even though it is not a route.
 * @param sidebarValue the map page's current sidebar, when it supplies one.
 * @param lastTapped the header's own fallback for pages that supply no
 *   `sidebarValue`.
 */
export function activeMobileNavItem({
  pathname,
  isAdmin,
  displayGroup,
  sidebarValue,
  lastTapped,
}: {
  pathname: string;
  isAdmin: boolean;
  displayGroup: boolean;
  sidebarValue?: string;
  lastTapped: string;
}): ActiveNavItem {
  if (pathname.includes("/profile")) {
    return "profile";
  }

  // Before the group modal, so that opening it on the admin page - which has
  // no control that can - could not light a tab either.
  if (isAdmin) {
    return null;
  }

  if (displayGroup) {
    return "mygroup";
  }

  const candidate = sidebarValue || lastTapped;

  // The ternary compared this against each item's id and simply matched
  // nothing when it was not a tab. Stated explicitly so the return type can
  // be the three tabs rather than `string`.
  return isNavTab(candidate) ? candidate : null;
}
