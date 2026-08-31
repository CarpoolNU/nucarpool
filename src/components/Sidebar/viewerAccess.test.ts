import {
  disclosesCounterpartName,
  isRequestSubType,
  viewerModeHidesCards,
  type SidebarSubType,
} from "./viewerAccess";

/**
 * The Requests tab used to be gated on the caller's own role, so a VIEWER could
 * not reach requests they had already sent and had no way to withdraw one
 * (SCRUM-316). These pin both halves of the rule: requests stay visible, and
 * recommendations stay hidden.
 *
 * There are no component tests in this repository (SCRUM-263 / SCRUM-264), so
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

describe("disclosesCounterpartName", () => {
  it("withholds the name from a VIEWER on a discovery card", () => {
    // The rule this preserves: a browsing user does not collect names of
    // students they have no relationship with.
    expect(disclosesCounterpartName("VIEWER", false)).toBe(false);
  });

  it("shows the name to a VIEWER on a request card", () => {
    // The regression SCRUM-316 would otherwise have introduced: three sent
    // requests all reading "Driver", with nothing to tell them apart.
    expect(disclosesCounterpartName("VIEWER", true)).toBe(true);
  });

  it.each(["DRIVER", "RIDER"])(
    "shows the name to a %s either way, exactly as before",
    (role) => {
      expect(disclosesCounterpartName(role, false)).toBe(true);
      expect(disclosesCounterpartName(role, true)).toBe(true);
    },
  );

  it("only ever withholds in the one VIEWER-on-discovery case", () => {
    const cases = [
      ["VIEWER", false],
      ["VIEWER", true],
      ["DRIVER", false],
      ["DRIVER", true],
      ["RIDER", false],
      ["RIDER", true],
    ] as const;
    const withheld = cases.filter(
      ([role, isCounterpart]) => !disclosesCounterpartName(role, isCounterpart),
    );

    expect(withheld).toEqual([["VIEWER", false]]);
  });
});

describe("the predicates together", () => {
  it("never hides a request tab", () => {
    // The invariant SCRUM-316 exists to establish: being in Viewer mode must
    // not remove a relationship the user already has.
    for (const subType of ALL_SUB_TYPES) {
      if (isRequestSubType(subType)) {
        expect(viewerModeHidesCards(subType)).toBe(false);
      }
    }
  });

  it("shows a VIEWER the name on every tab it does not hide, except favorites", () => {
    // Favorites is the one list a VIEWER can see without a relationship, so it
    // keeps the discovery rule. Requests are relationships and do not.
    expect(viewerModeHidesCards("favorites")).toBe(false);
    expect(disclosesCounterpartName("VIEWER", false)).toBe(false);

    for (const subType of ALL_SUB_TYPES.filter(isRequestSubType)) {
      expect(viewerModeHidesCards(subType)).toBe(false);
      expect(disclosesCounterpartName("VIEWER", true)).toBe(true);
    }
  });
});
