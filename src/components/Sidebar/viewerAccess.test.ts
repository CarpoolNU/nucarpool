import {
  isRequestSubType,
  roleFetchesRecommendations,
  viewerModeHidesCards,
  type SidebarSubType,
} from "./viewerAccess";

/**
 * Viewer mode hides the recommendations tab and nothing else. Gating the
 * Requests tab on the caller's own role instead would leave a VIEWER unable to
 * reach requests they had already sent, with no way to withdraw one. These pin
 * both halves of the rule: requests stay visible, and recommendations stay
 * hidden.
 *
 * The sidebar itself has no suite, so this is the only place the gate is
 * checked. It is a predicate rather than inline JSX for exactly that reason.
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
    // Worth pinning because it is the fact that settles the name-withholding
    // question. A rule printing a counterpart's role in place of their name on
    // "discovery" cards would reach exactly this surface: recommendations are
    // replaced by copy and requests are relationships, so it would apply only
    // to the reader's own favourites, where a former Driver who saved three
    // people and switched to Viewer would read "Driver", "Driver", "Rider".
    //
    // Nothing withholds a name, and there is no predicate to test for it - see
    // the note at the top of `viewerAccess.ts` for why, and for what a real
    // control would have to do instead.
    const visibleNonRequestTabs = ALL_SUB_TYPES.filter(
      (subType) => !viewerModeHidesCards(subType) && !isRequestSubType(subType),
    );

    expect(visibleNonRequestTabs).toEqual(["favorites"]);
  });
});

describe("roleFetchesRecommendations", () => {
  // `user.recommendations.me` is a ranked scoring pass returning up to 50
  // candidates, and a VIEWER's copy of it was discarded unrendered on
  // every mount. "A query did not fire" is not something the mocked suite can
  // observe, which is why the rule is a predicate and why these are its tests.

  it("does not fetch for a VIEWER, whose cards are replaced by copy", () => {
    expect(roleFetchesRecommendations("VIEWER")).toBe(false);
  });

  it.each(["RIDER", "DRIVER"])(
    "still fetches for a %s — the behaviour that must not regress",
    (role) => {
      expect(roleFetchesRecommendations(role)).toBe(true);
    },
  );

  it("does not fetch before the role is known", () => {
    // `user?.role` is `undefined` until `user.me` resolves. Answering `true`
    // here would fire the request this exists to prevent, every time, for
    // everyone — before the answer was knowable.
    expect(roleFetchesRecommendations(undefined)).toBe(false);
  });

  it("releases the query once a real role arrives, rather than staying off", () => {
    // The other half of the case above: a term that tolerates the initial
    // `undefined` by disabling the query must not leave it disabled for a
    // RIDER or a DRIVER once the role lands.
    const beforeUserMe = roleFetchesRecommendations(undefined);
    const afterUserMe = roleFetchesRecommendations("RIDER");

    expect([beforeUserMe, afterUserMe]).toEqual([false, true]);
  });

  it("agrees with the render gate rather than restating it", () => {
    // The invariant that makes this safe to keep: the query is skipped for
    // exactly the role whose recommendation cards `SidebarContent` replaces.
    // If `viewerModeHidesCards("recommendations")` ever turns false, a VIEWER
    // is being shown real cards and must be fetching them again.
    expect(roleFetchesRecommendations("VIEWER")).toBe(
      !viewerModeHidesCards("recommendations"),
    );
  });

  it("fetches for an unrecognised role rather than withholding the list", () => {
    // Failing open matches `viewerModeHidesCards`: a role nobody gated is a
    // role that still sees cards, and a tab with cards needs the query behind
    // them. Only the empty-string case is worth pinning alongside, since it is
    // what a mistyped enum would look like.
    expect(roleFetchesRecommendations("MANAGER")).toBe(true);
    expect(roleFetchesRecommendations("")).toBe(true);
  });
});
