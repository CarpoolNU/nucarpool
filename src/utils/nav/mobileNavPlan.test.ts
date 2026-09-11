import {
  activeMobileNavItem,
  isNavTab,
  planMobileNav,
  tabHref,
} from "./mobileNavPlan";

/**
 * The mobile bottom navigation's decision.
 *
 * The defect: leaving the profile page went straight to a full page load, so
 * every unsaved form value went with it and `UnsavedModal` could not appear on
 * mobile at all. The guard existed and was wired to the desktop map button
 * only.
 *
 * These tests are as much about what must *not* change. Two behaviours are
 * load-bearing and easy to break while fixing the first:
 *
 *  - the full page load itself, which is that change's fix for "can't switch
 *    from profile to explore/requests on a real phone"; and
 *  - immediate navigation from pages that supply no guard, which is every page
 *    except the profile one.
 */

const from =
  (pathname: string, hasUnsavedGuard = true) =>
  (option: string) =>
    planMobileNav({ option, pathname, hasUnsavedGuard });

describe("planMobileNav — leaving the profile page", () => {
  const onProfile = from("/profile");

  it.each(["explore", "requests", "mygroup"] as const)(
    "asks the guard before leaving for %s",
    (option) => {
      // The whole ticket: this used to navigate immediately.
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
    // Both profile plans must be href-carrying, because a router
    // push here did not work on real devices.
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
      expect(from("/")(option)).toEqual({ kind: "switchTab", tab: option });
    },
  );

  it("does not consult the guard when not on the profile page", () => {
    // A guard prop on a non-profile page must not add a modal to ordinary tab
    // switching. `kind` is what the caller branches on, so this is the
    // assertion that matters.
    expect(from("/", true)("explore").kind).toBe("switchTab");
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
    // `pathname.includes` is the test the inline version used, so
    // /profile/setup counts. Preserved rather than tightened: narrowing it
    // here would silently drop the guard on a route that has one.
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
    // The whole point. `/admin` supplies no `sidebarValue`, so the inline
    // ternary this replaced fell through to `activeNav` - initial value
    // "explore" - and the bar claimed the user was on the map.
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
    // Preserved precedence: this used to be the first arm of the ternary, and
    // it is what stops a cancelled unsaved-changes modal leaving a tab lit
    // that was never reached.
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
    // not, which is how the admin page came to borrow "explore".
    expect(active({ sidebarValue: "requests", lastTapped: "explore" })).toBe(
      "requests",
    );
  });

  it("falls back to the last tap when no sidebar value is supplied", () => {
    expect(active({ lastTapped: "mygroup" })).toBe("mygroup");
  });

  it("lights nothing for a value that is not a tab", () => {
    // The ternary compared a bare string against each id and matched none.
    // Same outcome, now stated in the type.
    expect(active({ sidebarValue: "settings" })).toBeNull();
    expect(active({ sidebarValue: "", lastTapped: "" })).toBeNull();
  });
});
