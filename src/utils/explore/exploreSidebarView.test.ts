import { Role, Status } from "@prisma/client";
import type { NavTab } from "../nav/mobileNavPlan";
import {
  isSheetDetentView,
  planExploreSidebar,
  resolveMobileSelectedUser,
  type ExploreSidebarView,
} from "./exploreSidebarView";
import { defaultSheetDetent, type SheetDetent } from "./sheetDetents";

/**
 * The explore sidebar's visibility decision.
 *
 * The property that matters is that the view is a *function of state*, so no
 * re-render can disagree with it - a guarantee no imperative DOM write could
 * ever give. These tests pin that function.
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
    // An open conversation always takes the sidebar out of layout entirely.
    expect(view({ hasOpenConversation: true })).toBe("hidden");
  });

  it("stays hidden when the collapse handle is toggled", () => {
    // Both values below must be "hidden": toggling the collapse handle must
    // not re-expose a card list over an open conversation.
    for (const detent of detents) {
      expect(view({ hasOpenConversation: true, detent })).toBe("hidden");
    }
  });

  it("outranks a detail view", () => {
    // An open conversation outranks a detail view too: hiding the sidebar
    // entirely always wins.
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

describe("planExploreSidebar - the detent and selection states", () => {
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

describe("isSheetDetentView", () => {
  it("accepts exactly the three views that are detents", () => {
    // The predicate decides two things at once - whether the drag handle is
    // rendered, and whether `useSheetDrag` will begin a gesture - so the set it
    // accepts is the set of states the sheet can be dragged in.
    const detents: SheetDetent[] = ["collapsed", "half", "expanded"];

    for (const detent of detents) {
      expect(isSheetDetentView(detent)).toBe(true);
    }
  });

  it("rejects the views that have no drag range", () => {
    // `desktop` is not a sheet at all, `hidden` is out of layout, and `detail`
    // is a different sheet at a fixed height pinned to the same bottom edge -
    // dragging it against the full range would resize it to a height its view
    // has no classes for.
    for (const other of ["desktop", "hidden", "detail"] as const) {
      expect(isSheetDetentView(other)).toBe(false);
    }
  });

  it("agrees with the views a detent can actually produce", () => {
    // The gap between the handle's render condition and the drag's
    // precondition is closed: they are one predicate now, and this is the
    // link back to `planExploreSidebar`: every view a detent resolves to is
    // one the drag accepts.
    for (const detent of ["collapsed", "half", "expanded"] as SheetDetent[]) {
      const produced = view({
        isMobile: true,
        hasOpenConversation: false,
        isDetailOpen: false,
        detent,
      });

      expect(isSheetDetentView(produced)).toBe(true);
    }
  });
});

/**
 * SCRUM-709, the regression case.
 *
 * `planExploreSidebar` was never wrong here - given `collapsed` it correctly
 * returned `collapsed`. The defect was one step upstream, in which detent the
 * page resolved on arrival, and the only way to see it is to run the two
 * functions in the order `index.tsx` runs them. Neither half fails alone, so
 * a test of either alone would have gone on passing through the whole bug.
 *
 * This is the closest the suite can get to the user's report. `index.tsx` is
 * not renderable in jsdom - Mapbox, NextAuth and a dozen tRPC queries - so the
 * composition is reproduced here from the same two exports the page imports,
 * rather than observed. What it cannot show is that the sheet is *visible*:
 * jsdom does no layout, and the view-to-class mapping lives in `index.tsx`.
 * A phone-width Chromium pass is the evidence for that half.
 *
 * It asserts the view rather than a class string on purpose. The view is the
 * contract this module publishes - its own docblock makes that argument - and
 * Tailwind v4 scans this file, so spelling the collapsed utilities out here
 * would emit each one into the bundle whether or not anything renders it.
 */
describe("the mobile My Group screen is reachable (SCRUM-709)", () => {
  /** The page's own chain: opening position in, view out. */
  const arriveOn = (sidebarType: NavTab, role: Role): ExploreSidebarView =>
    planExploreSidebar({
      isMobile: true,
      hasOpenConversation: false,
      isDetailOpen: false,
      // `null` override: a tab change drops whatever the user had chosen, so
      // every arrival re-reads the default. That is what made this permanent
      // rather than a first-visit glitch.
      detent: defaultSheetDetent({ role, status: Status.ACTIVE, sidebarType }),
    });

  it("gives a VIEWER a visible screen on arrival", () => {
    // The bug: this was `collapsed`, and `collapsed` is
    // zero-height/zero-opacity/no-pointer-events, which reaches `GroupPage`'s
    // `position: fixed` overlay through the subtree. The tab lit up and
    // nothing was drawn.
    expect(arriveOn("mygroup", Role.VIEWER)).toBe("expanded");
  });

  it("gives a RIDER and a DRIVER the same screen it always did", () => {
    expect(arriveOn("mygroup", Role.RIDER)).toBe("expanded");
    expect(arriveOn("mygroup", Role.DRIVER)).toBe("expanded");
  });

  it("leaves the VIEWER's explore sheet collapsed on arrival", () => {
    // The guard on the fix. The role default exists so an empty
    // recommendations list does not cover the route-search panel; if this ever
    // flips, SCRUM-668's defect is back and this ticket caused it.
    expect(arriveOn("explore", Role.VIEWER)).toBe("collapsed");
  });

  it("still collapses My Group when the user asks it to", () => {
    // Not a detail: `GroupPage`'s Close button is `collapseSidebar(true)`, and
    // since its mobile branch renders the overlay unconditionally rather than
    // off its own `isOpen`, this view is the only thing that dismisses the
    // screen. A fix that made My Group ignore the detent - the one the ticket
    // first proposed - would have left that button inert. Tapping the tab
    // again drops the override and brings the screen back.
    expect(
      planExploreSidebar({
        isMobile: true,
        hasOpenConversation: false,
        isDetailOpen: false,
        detent: "collapsed",
      }),
    ).toBe("collapsed");
  });
});
