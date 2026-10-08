import {
  activeMobileNavItem,
  isNavTab,
  planMobileNav,
  tabHref,
} from "./mobileNavPlan";

/**
 * The mobile bottom navigation's decision.
 *
 * Leaving the profile page must ask `checkChanges` before navigating, so
 * `UnsavedModal` can appear on mobile the same way it does on the desktop map
 * button.
 *
 * These tests are as much about what must *not* change. Two behaviours are
 * load-bearing and easy to break while changing the first:
 *
 *  - the full page load itself, which real phones need for leaving profile
 *    for explore/requests; and
 *  - immediate navigation from pages that supply no guard, which is every page
 *    except the profile one.
 */

const from =
  (pathname: string, hasUnsavedGuard = true) =>
  (option: string, currentTab?: string) =>
    planMobileNav({ option, pathname, hasUnsavedGuard, currentTab });

describe("planMobileNav — leaving the profile page", () => {
  const onProfile = from("/profile");

  it.each(["explore", "requests", "mygroup"] as const)(
    "asks the guard before leaving for %s",
    (option) => {
      expect(onProfile(option)).toEqual({
        kind: "guard",
        href: `/?tab=${option}`,
        tab: option,
      });
    },
  );

  it("still carries the destination the user asked for", () => {
    // Save has to land them on that tab, not on the map's default.
    const plan = onProfile("requests");

    expect(plan).toMatchObject({ href: "/?tab=requests", tab: "requests" });
  });

  it("navigates immediately when no guard is supplied", () => {
    // Only the profile page passes `checkChanges`. A page without one must not
    // be made to wait for a modal that will never render.
    expect(from("/profile", false)("explore")).toEqual({
      kind: "hardNavigate",
      href: "/?tab=explore",
      tab: "explore",
    });
  });

  it("keeps the full page load rather than a client-side push", () => {
    // Both profile plans must be href-carrying, because a router push does
    // not work reliably here on real devices.
    for (const guard of [true, false]) {
      const plan = from("/profile", guard)("mygroup");
      expect(plan).toHaveProperty("href", "/?tab=mygroup");
      expect(plan.kind).not.toBe("switchTab");
    }
  });
});

describe("planMobileNav — elsewhere", () => {
  it.each(["explore", "requests", "mygroup"] as const)(
    "switches tab in place for %s",
    (option) => {
      // On the map page there is nothing to lose and no reload needed.
      // `currentTab` is omitted here, so this is also the "switching in from
      // elsewhere" case: never equal to `option`, so never `reselected`.
      expect(from("/")(option)).toEqual({
        kind: "switchTab",
        tab: option,
        reselected: false,
      });
    },
  );

  it("does not consult the guard when not on the profile page", () => {
    // A guard prop on a non-profile page must not add a modal to ordinary tab
    // switching. `kind` is what the caller branches on, so this is the
    // assertion that matters.
    expect(from("/", true)("explore").kind).toBe("switchTab");
  });

  it.each(["explore", "requests", "mygroup"] as const)(
    "marks %s reselected when it was already the active tab",
    (option) => {
      // The case `reselected` exists for: My Group's sheet can be collapsed
      // by the header's Close button while the tab itself stays active, and
      // tapping that same tab again is the only way back in.
      expect(from("/")(option, option)).toMatchObject({ reselected: true });
    },
  );

  it("does not mark a switch from a different tab as reselected", () => {
    expect(from("/")("mygroup", "explore")).toMatchObject({
      reselected: false,
    });
  });

  it("opens the profile page from anywhere", () => {
    expect(from("/")("profile")).toEqual({ kind: "openProfile" });
    expect(from("/profile")("profile")).toEqual({ kind: "openProfile" });
  });

  it("ignores an option the navigation does not handle", () => {
    expect(from("/")("settings")).toEqual({ kind: "ignore" });
    expect(from("/profile")("")).toEqual({ kind: "ignore" });
  });

  it("treats a nested profile route as the profile page", () => {
    // `pathname.includes` means /profile/setup counts as the profile page.
    // Preserved rather than tightened: narrowing it here would silently drop
    // the guard on a route that has one.
    expect(from("/profile/setup")("explore").kind).toBe("guard");
  });
});

describe("isNavTab and tabHref", () => {
  it("accepts exactly the three tabs", () => {
    expect(["explore", "requests", "mygroup"].every(isNavTab)).toBe(true);
    expect(isNavTab("profile")).toBe(false);
    expect(isNavTab("")).toBe(false);
  });

  it("builds the href the destination page reads back", () => {
    // `Header`'s own effect reads `?tab=`; nothing else survives a full load.
    expect(tabHref("requests")).toBe("/?tab=requests");
  });
});

describe("activeMobileNavItem", () => {
  const active = (
    overrides: Partial<Parameters<typeof activeMobileNavItem>[0]> = {},
  ) =>
    activeMobileNavItem({
      pathname: "/",
      isAdmin: false,
      displayGroup: false,
      lastTapped: "explore",
      ...overrides,
    });

  it("lights nothing on the admin page", () => {
    // `/admin` supplies no `sidebarValue` and has no fourth tab, so this
    // must be null rather than falling back to whatever `lastTapped` holds.
    expect(active({ isAdmin: true })).toBeNull();
  });

  it("still lights nothing on the admin page when the group modal is open", () => {
    // No control on that page can open it, so this is defence against a later
    // one being added rather than a reachable state today.
    expect(active({ isAdmin: true, displayGroup: true })).toBeNull();
  });

  it("lights nothing on the admin page whatever was last tapped", () => {
    expect(active({ isAdmin: true, lastTapped: "requests" })).toBeNull();
  });

  it("pins the profile page ahead of everything else", () => {
    // Checked first: this is what stops a cancelled unsaved-changes modal
    // leaving a tab lit that was never reached.
    expect(active({ pathname: "/profile", lastTapped: "requests" })).toBe(
      "profile",
    );
    expect(active({ pathname: "/profile/setup" })).toBe("profile");
    expect(active({ pathname: "/profile", displayGroup: true })).toBe(
      "profile",
    );
  });

  it("reflects the group modal on the map page", () => {
    expect(active({ displayGroup: true })).toBe("mygroup");
  });

  it("prefers the page's sidebar over the last tap", () => {
    // `index.tsx` supplies `sidebarValue`; the fallback is for pages that do
    // not, which is why the admin page needs its own branch above rather than
    // defaulting to "explore".
    expect(active({ sidebarValue: "requests", lastTapped: "explore" })).toBe(
      "requests",
    );
  });

  it("falls back to the last tap when no sidebar value is supplied", () => {
    expect(active({ lastTapped: "mygroup" })).toBe("mygroup");
  });

  it("lights nothing for a value that is not a tab", () => {
    // Matches none of the tabs when the value is not one, now stated in the
    // return type rather than left implicit.
    expect(active({ sidebarValue: "settings" })).toBeNull();
    expect(active({ sidebarValue: "", lastTapped: "" })).toBeNull();
  });
});
