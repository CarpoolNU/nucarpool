import {
  isRequestSubType,
  viewerModeHidesCards,
  type SidebarSubType,
} from "./viewerAccess";

/**
 * The Requests tab used to be gated on the caller's own role, so a VIEWER could
 * not reach requests they had already sent and had no way to withdraw one.
 * These pin both halves of the rule: requests stay visible, and
 * recommendations stay hidden.
 *
 * There are no component tests in this repository, so
 * this is the only place the gate is checked. It is a predicate rather than
 * inline JSX for exactly that reason.
 */

const ALL_SUB_TYPES: SidebarSubType[] = [
  "recommendations",
  "favorites",
  "sent",
  "received",
  "all",
];

describe("viewerModeHidesCards", () => {
  it("hides recommendations, which is discovery and excludes a VIEWER anyway", () => {
    expect(viewerModeHidesCards("recommendations")).toBe(true);
  });

  it.each(["sent", "received", "all"])(
    "does not hide the %s requests tab — the regression this fixes",
    (subType) => {
      expect(viewerModeHidesCards(subType)).toBe(false);
    },
  );

  it("does not hide favorites, which was already exempt before this change", () => {
    expect(viewerModeHidesCards("favorites")).toBe(false);
  });

  it("hides exactly one of the five sub-tabs", () => {
    // Stated as a count so that adding a tab without deciding its Viewer-mode
    // behaviour shows up here rather than silently defaulting to visible.
    expect(ALL_SUB_TYPES.filter(viewerModeHidesCards)).toEqual([
      "recommendations",
    ]);
  });

  it("treats an unrecognised sub-tab as visible rather than hidden", () => {
    // Failing open is right for a *display* gate: the server decides what a
    // VIEWER may actually do, and every mutation on this path checks
    // participation. Hiding a list nobody meant to hide loses information.
    expect(viewerModeHidesCards("something-new")).toBe(false);
    expect(viewerModeHidesCards("")).toBe(false);
  });
});

describe("isRequestSubType", () => {
  it.each(["sent", "received", "all"])("recognises %s", (subType) => {
    expect(isRequestSubType(subType)).toBe(true);
  });

  it.each(["recommendations", "favorites"])(
    "does not treat %s as a request tab",
    (subType) => {
      expect(isRequestSubType(subType)).toBe(false);
    },
  );

  it("is exactly the complement of the explore tabs across all five", () => {
    expect(ALL_SUB_TYPES.filter(isRequestSubType)).toEqual([
      "sent",
      "received",
      "all",
    ]);
  });

  it("does not recognise an unrelated string", () => {
    expect(isRequestSubType("requests")).toBe(false);
    expect(isRequestSubType("")).toBe(false);
  });
});

describe("the predicates together", () => {
  it("never hides a request tab", () => {
    // The invariant that matters: being in Viewer mode must
    // not remove a relationship the user already has.
    for (const subType of ALL_SUB_TYPES) {
      if (isRequestSubType(subType)) {
        expect(viewerModeHidesCards(subType)).toBe(false);
      }
    }
  });

  it("leaves favorites as the only non-request tab a VIEWER can see", () => {
    // Worth pinning because it is the fact that decided SCRUM-323. Viewer mode
    // used to print a counterpart's role in place of their name on "discovery"
    // cards, and this is the whole of the surface that reached: recommendations
    // are replaced by copy, requests are relationships, so the rule only ever
    // applied to the reader's own favourites. A former Driver who saved three
    // people and switched to Viewer read "Driver", "Driver", "Rider".
    //
    // Nothing withholds a name now, and there is no predicate left to test for
    // it - see the note at the top of `viewerAccess.ts` for why, and for what a
    // real control would have to do instead.
    const visibleNonRequestTabs = ALL_SUB_TYPES.filter(
      (subType) => !viewerModeHidesCards(subType) && !isRequestSubType(subType),
    );

    expect(visibleNonRequestTabs).toEqual(["favorites"]);
  });
});
