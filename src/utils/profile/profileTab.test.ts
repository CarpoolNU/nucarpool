/**
 * The profile tab vocabulary, and what it does with input it did not write.
 *
 * `parseProfileTab` reads `router.query`, which is the address bar, so the
 * cases that matter are the malformed ones: the page must fall back to the
 * default rather than render a tab that does not exist or throw on a value
 * that is not a string.
 */

import {
  DEFAULT_PROFILE_TAB,
  PROFILE_TABS,
  PROFILE_TAB_QUERY_KEY,
  parseProfileTab,
  profileTabRoute,
} from "./profileTab";

describe("parseProfileTab", () => {
  it.each(PROFILE_TABS)("accepts %s, the name the sidebar uses", (tab) => {
    expect(parseProfileTab(tab)).toBe(tab);
  });

  it("rejects a tab name that does not exist", () => {
    expect(parseProfileTab("safety")).toBeNull();
  });

  it("rejects a tab name differing only in case, rather than normalising it", () => {
    // Not a style preference: accepting `Account` would mean the page has two
    // spellings for one tab, and every later comparison has to know which.
    expect(parseProfileTab("Account")).toBeNull();
  });

  it("rejects a repeated parameter instead of taking the first", () => {
    // `?tab=account&tab=user` - Next parses a repeat into an array, and there
    // is no honest answer to which the user meant.
    expect(parseProfileTab(["account", "user"])).toBeNull();
  });

  it("rejects a missing parameter", () => {
    expect(parseProfileTab(undefined)).toBeNull();
  });

  it.each([null, 7, {}, true])("does not throw on %p", (value) => {
    expect(parseProfileTab(value)).toBeNull();
  });
});

describe("the default", () => {
  it("is the tab the page opened on before any of this existed", () => {
    // A bare `/profile` must be unchanged by the deep-link support.
    expect(DEFAULT_PROFILE_TAB).toBe("user");
  });

  it("is itself a valid tab", () => {
    expect(parseProfileTab(DEFAULT_PROFILE_TAB)).toBe(DEFAULT_PROFILE_TAB);
  });
});

describe("profileTabRoute", () => {
  it("targets the profile page under the shared query key", () => {
    expect(profileTabRoute("account")).toEqual({
      pathname: "/profile",
      query: { tab: "account" },
    });
  });

  it("round-trips through parseProfileTab", () => {
    // The writer and the reader agreeing is the whole contract; asserting it
    // here means a change to the query key cannot pass by updating one side.
    for (const tab of PROFILE_TABS) {
      const route = profileTabRoute(tab);
      expect(parseProfileTab(route.query[PROFILE_TAB_QUERY_KEY])).toBe(tab);
    }
  });
});
