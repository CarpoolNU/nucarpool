import {
  planExploreSidebar,
  resolveMobileSelectedUser,
  type ExploreSidebarView,
} from "./exploreSidebarView";
import type { SheetDetent } from "./sheetDetents";

/**
 * The explore sidebar's visibility decision.
 *
 * The defect was not a wrong value, it was that three mechanisms wrote the
 * same DOM node's class list and two of them were invisible to React. That is
 * not directly testable here and does not need to be: once the imperative
 * calls are gone the property that matters is that the view is a *function of
 * state*, so no re-render can disagree with it. These tests pin that function.
 *
 * `mobileNavPlan.test.ts` is the shape being followed - and like that suite,
 * as much of this is about what must not change as about what must.
 *
 * The `isCollapsed` boolean became a three-valued `detent` when the sheet
 * gained a draggable `half` position, so every sweep below runs over three
 * detents rather than two. The cases that existed before are unchanged in
 * meaning: `detent: "collapsed"` is the old `isCollapsed: true`, and
 * `"expanded"` the old `false`.
 */

const view = (
  overrides: Partial<Parameters<typeof planExploreSidebar>[0]> = {},
): ExploreSidebarView =>
  planExploreSidebar({
    isMobile: true,
    hasOpenConversation: false,
    isDetailOpen: false,
    detent: "expanded",
    ...overrides,
  });

/** The sheet's three resting positions, swept wherever the old suite swept two. */
const detents: SheetDetent[] = ["collapsed", "half", "expanded"];

/** Every combination of the three mobile inputs, for the sweeps below. */
const mobileStates = [false, true].flatMap((hasOpenConversation) =>
  [false, true].flatMap((isDetailOpen) =>
    detents.map((detent) => ({
      hasOpenConversation,
      isDetailOpen,
      detent,
    })),
  ),
);

describe("planExploreSidebar - an open conversation", () => {
  it("takes the sidebar out of layout", () => {
    // The whole ticket. This is what a `useEffect` reaching for
    // `classList.add("hidden")` was trying and failing to achieve.
    expect(view({ hasOpenConversation: true })).toBe("hidden");
  });

  it("stays hidden when the collapse handle is toggled", () => {
    // The user-facing regression, stated as directly as it can be. Toggling
    // the handle re-rendered the sidebar with a different `className`, React
    // reassigned the whole attribute, and the imperatively added `hidden` went
    // with it - the effect would not re-fire, because `selectedUser` had not
    // changed. Both values below must be "hidden"; before the fix the second
    // state produced a visible card list over the open conversation.
    for (const detent of detents) {
      expect(view({ hasOpenConversation: true, detent })).toBe("hidden");
    }
  });

  it("outranks a detail view", () => {
    // `display: none` beat every other class in the old expression whatever
    // order they appeared in. Preserved deliberately.
    expect(view({ hasOpenConversation: true, isDetailOpen: true })).toBe(
      "hidden",
    );
  });

  it("hides regardless of the other two inputs", () => {
    for (const state of mobileStates.filter((s) => s.hasOpenConversation)) {
      expect(view(state)).toBe("hidden");
    }
  });

  it("releases the sidebar again once the conversation closes", () => {
    // The effect's `else` branch, which did work - so it must keep working.
    expect(view({ hasOpenConversation: false })).toBe("expanded");
  });
});

describe("planExploreSidebar - the states that already worked", () => {
  it("expands to the full list sheet by default", () => {
    expect(view()).toBe("expanded");
  });

  it("collapses when the handle is closed", () => {
    expect(view({ detent: "collapsed" })).toBe("collapsed");
  });

  it("renders the half sheet a drag can land on", () => {
    // The detent the drag gesture exists for. It has no other route in: a tap
    // goes straight between `collapsed` and `expanded`.
    expect(view({ detent: "half" })).toBe("half");
  });

  it("shows a detail view when a card is selected", () => {
    expect(view({ isDetailOpen: true })).toBe("detail");
  });

  it("prefers the detail view over the sheet's own detent", () => {
    // Matches the order of the original ternary chain: `mobileSelectedUserID`
    // was tested before `isSidebarCollapsed`. Swept across all three detents,
    // because `half` is reachable while a detail view opens - a drag to half
    // and then a tap on a card - and the details are still what was asked for.
    for (const detent of detents) {
      expect(view({ isDetailOpen: true, detent })).toBe("detail");
    }
  });
});

describe("planExploreSidebar - desktop", () => {
  it("is a static column", () => {
    expect(view({ isMobile: false })).toBe("desktop");
  });

  it("ignores every mobile input", () => {
    // "Desktop behaviour is unchanged" as an assertion rather than a claim.
    // The old code gated each `classList` call on `isMobile` independently,
    // so this invariant lived in three places at once.
    for (const state of mobileStates) {
      expect(view({ ...state, isMobile: false })).toBe("desktop");
    }
  });

  it("never returns a mobile view, and never returns desktop on mobile", () => {
    for (const state of mobileStates) {
      expect(view({ ...state, isMobile: false })).toBe("desktop");
      expect(view({ ...state, isMobile: true })).not.toBe("desktop");
    }
  });
});

describe("planExploreSidebar - totality", () => {
  it("returns a known view for every reachable state", () => {
    const known: ExploreSidebarView[] = [
      "desktop",
      "hidden",
      "detail",
      "collapsed",
      "half",
      "expanded",
    ];

    for (const isMobile of [false, true]) {
      for (const state of mobileStates) {
        expect(known).toContain(view({ ...state, isMobile }));
      }
    }
  });

  it("reaches all six views", () => {
    // A view nothing can produce is a class the page carries for no reason.
    const reached = new Set<ExploreSidebarView>();
    for (const isMobile of [false, true]) {
      for (const state of mobileStates) {
        reached.add(view({ ...state, isMobile }));
      }
    }
    expect([...reached].sort()).toEqual([
      "collapsed",
      "desktop",
      "detail",
      "expanded",
      "half",
      "hidden",
    ]);
  });

  it("depends on nothing but its inputs", () => {
    // The property that replaces the effect: called twice with equal state it
    // gives equal answers, so a re-render cannot disagree with it. An
    // imperative `classList` call could, and did.
    for (const isMobile of [false, true]) {
      for (const state of mobileStates) {
        expect(view({ ...state, isMobile })).toBe(view({ ...state, isMobile }));
      }
    }
  });
});

/**
 * The expanded card's viewport masking.
 *
 * The ticket asked for a jsdom test that crosses the breakpoint mid-render and
 * asserts the expanded state does not survive it, because it proposed clearing
 * the state from an effect - and an effect on a state transition can only be
 * checked by driving the transition. Deriving the value instead removes the
 * transition, so there is nothing to drive: the function has two boolean
 * branches and both are covered below, which is stronger than a resize test
 * rather than a substitute for one.
 *
 * Two things this deliberately does not claim. It says nothing about the
 * desktop sidebar *looking* right after a rotation - jsdom does no layout, and
 * `src/testing/viewport.ts` sets out what that rules out. And it cannot prove
 * `index.tsx` actually routes its reads through here; that is a property of a
 * 1300-line page behind Mapbox and NextAuth, and the guard against it is that
 * the raw state is named `expandedUserId`, so a read of `mobileSelectedUserID`
 * that bypassed this would not compile.
 */
describe("resolveMobileSelectedUser", () => {
  const EXPANDED = "user-42";

  it("passes the expanded card through on mobile", () => {
    expect(
      resolveMobileSelectedUser({ isMobile: true, expandedUserId: EXPANDED }),
    ).toBe(EXPANDED);
  });

  it("reports no expanded card on desktop, however the state was left", () => {
    // The whole ticket. The raw state survives a breakpoint crossing because
    // nothing writes to it on the way out, so this is the read that has to
    // lie about it - and consumers now rely on that, having given up their own
    // defensive checks.
    expect(
      resolveMobileSelectedUser({ isMobile: false, expandedUserId: EXPANDED }),
    ).toBeNull();
  });

  it("is null on desktop even with nothing expanded", () => {
    // Guards against a mutation that returns `expandedUserId` unconditionally:
    // that passes the mobile case above and the null-state case here, and only
    // the stale-state case catches it. Stated so the trio reads as complete.
    expect(
      resolveMobileSelectedUser({ isMobile: false, expandedUserId: null }),
    ).toBeNull();
  });

  it("never invents a selection", () => {
    // Both viewports, so a hard-coded id fails in one of them.
    for (const isMobile of [false, true]) {
      expect(
        resolveMobileSelectedUser({ isMobile, expandedUserId: null }),
      ).toBeNull();
    }
  });
});
