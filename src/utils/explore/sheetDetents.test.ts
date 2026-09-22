import { Role } from "@prisma/client";
import { MOBILE_SHEET_MAP_STRIP_REM } from "../breakpoints";
import {
  defaultSheetDetent,
  detentHeightPx,
  dragHeightPx,
  expandedSheetHeightPx,
  handleBottomPx,
  isTap,
  snapToDetent,
  TAP_SLOP_PX,
  toggleSheetDetent,
  type SheetDetent,
} from "./sheetDetents";

/**
 * The arithmetic behind dragging the mobile explore sheet.
 *
 * **This is the only part of the gesture a test in this repository can reach.**
 * jsdom does no layout and dispatches no real pointer sequences, so whether
 * the sheet follows a thumb is a question for a device — see
 * `src/testing/viewport.ts` for the measured list of what jsdom cannot tell
 * you, and the PR for the manual pass. What *is* testable is where a release
 * lands, and that is the half of the feature that can be silently wrong: a
 * snap that rounds the wrong way, or a tap that registers as a one-pixel drag
 * and snaps back to where it started, reproducing the original bug in a new
 * place.
 *
 * Heights are expressed against an expanded sheet of 400px throughout, so the
 * detents are 0, 200 and 400 and the boundaries between them are 100 and 300.
 */

const EXPANDED = 400;

const snap = (heightPx: number): SheetDetent =>
  snapToDetent({ heightPx, expandedHeightPx: EXPANDED });

describe("expandedSheetHeightPx", () => {
  /** A 16px root, so the 5.5rem map strip is 88px. */
  const ROOT = 16;
  const STRIP = MOBILE_SHEET_MAP_STRIP_REM * ROOT;

  const range = (sheetBottomPx: number) =>
    expandedSheetHeightPx({ sheetBottomPx, rootFontSizePx: ROOT });

  /** The range a 718px bottom edge leaves: 630. */
  const EXPANDED_FROM_718 = 718 - STRIP;

  it("is the sheet's bottom edge less the strip of map above it", () => {
    // 812px iPhone X, whose 60px navigation and 34px home indicator put the
    // sheet's bottom edge at 718. The nav and the inset do not appear here at
    // all: both are below that edge, so measuring it is what removes them.
    expect(range(718)).toBe(EXPANDED_FROM_718);
  });

  it("gives a collapsed sheet a full range, which is the whole bug", () => {
    // SCRUM-459. A VIEWER's sheet opens `collapsed` and measures no height at
    // all, and before this their first gesture had no range to drag within.
    // The sheet's own height is not an input here - only the bottom edge its
    // classes pin it to, which is the same in every detent - so "collapsed"
    // is not a state this arithmetic can distinguish, let alone refuse.
    expect(range(718)).toBe(EXPANDED_FROM_718);
    expect(EXPANDED_FROM_718).toBeGreaterThan(0);
  });

  it("tracks the viewport rather than whatever it last saw", () => {
    // The pre-existing staleness the hook's docblock named: a rotation with
    // the sheet closed used to leave the cached range from the taller
    // viewport. Derived per gesture, a shorter viewport is simply a shorter
    // range.
    expect(range(330)).toBeLessThan(range(718));
  });

  it("scales the strip with the root font size, not with 16", () => {
    // `MAP_STRIP` is a rem, so a user who has enlarged their browser's default
    // text has a physically larger strip of map and a correspondingly shorter
    // sheet. Hard-coding pixels would drag the sheet up over it.
    expect(
      expandedSheetHeightPx({ sheetBottomPx: 718, rootFontSizePx: 20 }),
    ).toBe(718 - MOBILE_SHEET_MAP_STRIP_REM * 20);
  });

  it("reports no range at all for a sheet that is out of layout", () => {
    // `hidden` is `display: none`, so every figure on its rect is zero. The
    // clamp is what turns that into "nothing to drag" rather than a negative
    // range, which `dragHeightPx` would clamp against in the wrong direction.
    expect(range(0)).toBe(0);
  });

  it("reports no range for a viewport shorter than the strip it reserves", () => {
    // Absurdly short, but the arithmetic must not hand back a negative number
    // to a pointer handler that only checks for `<= 0`.
    expect(range(STRIP - 1)).toBe(0);
    expect(range(STRIP)).toBe(0);
  });
});

describe("detentHeightPx", () => {
  it("places the three detents at nothing, half and full", () => {
    expect(
      detentHeightPx({ detent: "collapsed", expandedHeightPx: EXPANDED }),
    ).toBe(0);
    expect(detentHeightPx({ detent: "half", expandedHeightPx: EXPANDED })).toBe(
      200,
    );
    expect(
      detentHeightPx({ detent: "expanded", expandedHeightPx: EXPANDED }),
    ).toBe(EXPANDED);
  });

  it("scales with the measured sheet rather than assuming a viewport", () => {
    // The expanded height is a CSS `calc()` against the viewport and the
    // safe-area inset, so it differs per device and changes on rotation. The
    // fractions are the fixed part; the pixels never are.
    expect(detentHeightPx({ detent: "half", expandedHeightPx: 601 })).toBe(
      300.5,
    );
  });
});

describe("toggleSheetDetent", () => {
  it("opens a collapsed sheet fully", () => {
    expect(toggleSheetDetent("collapsed")).toBe("expanded");
  });

  it("collapses an expanded sheet", () => {
    expect(toggleSheetDetent("expanded")).toBe("collapsed");
  });

  it("collapses from half, rather than cycling through the detents", () => {
    // The handle reads "Hide the list" in any state but `collapsed`, so a tap
    // has to do what the label says. A three-way cycle would make the label
    // wrong half the time and would also mean a tap can no longer close the
    // sheet in one press, which is what the control was for.
    expect(toggleSheetDetent("half")).toBe("collapsed");
  });

  it("returns to where it started after two taps, from every detent", () => {
    // True of `collapsed` and `expanded` before any of this existed, and worth
    // keeping: a tap is how anyone who is not dragging uses this control.
    expect(toggleSheetDetent(toggleSheetDetent("collapsed"))).toBe("collapsed");
    expect(toggleSheetDetent(toggleSheetDetent("expanded"))).toBe("expanded");
    // `half` is the exception, and the only one: there is no way back to a
    // detent a tap cannot express.
    expect(toggleSheetDetent(toggleSheetDetent("half"))).toBe("expanded");
  });
});

describe("defaultSheetDetent", () => {
  /**
   * SCRUM-455. The defect itself is unobservable from here — whether one box
   * paints over another is layout, and jsdom does none (`src/testing/
   * viewport.ts`). This is the one part of the fix that is a rule rather than a
   * position, so it is the one part a test can hold: *which* detent the sheet
   * opens in, per role. The manual mobile pass is still the acceptance
   * evidence for the rest.
   */
  it("opens collapsed for a VIEWER, whose panel an expanded sheet would cover", () => {
    expect(defaultSheetDetent(Role.VIEWER)).toBe("collapsed");
  });

  it("keeps the long-standing expanded default for a RIDER and a DRIVER", () => {
    // The regression that would matter most: this fix is for one role, and
    // taking the recommendation list off the screen for the other two would be
    // a far larger bug than the one being fixed.
    expect(defaultSheetDetent(Role.RIDER)).toBe("expanded");
    expect(defaultSheetDetent(Role.DRIVER)).toBe("expanded");
  });

  it("falls back to expanded before the role is known", () => {
    // `user.me` is still in flight on the first render. The page shows a
    // spinner rather than the sheet at that point, so this is unobservable
    // today; it is pinned so that it stays the harmless answer if that changes.
    expect(defaultSheetDetent(undefined)).toBe("expanded");
  });

  it("is only the opening position, not a rule a tap has to respect", () => {
    // A VIEWER who taps the handle gets the sheet, Favorites and all. The
    // default exists so the route-search panel is reachable without first
    // discovering the handle - not to withhold the sheet from the role.
    expect(toggleSheetDetent(defaultSheetDetent(Role.VIEWER))).toBe("expanded");
  });
});

describe("isTap", () => {
  it("treats a still finger as a tap", () => {
    expect(isTap(0)).toBe(true);
  });

  it("allows slop in both directions", () => {
    // A finger never holds still. Without this the tap path would be
    // unreachable on a touchscreen, which is the original defect relocated.
    expect(isTap(TAP_SLOP_PX)).toBe(true);
    expect(isTap(-TAP_SLOP_PX)).toBe(true);
  });

  it("calls anything past the slop a drag", () => {
    expect(isTap(TAP_SLOP_PX + 1)).toBe(false);
    expect(isTap(-(TAP_SLOP_PX + 1))).toBe(false);
  });
});

describe("dragHeightPx", () => {
  it("grows the sheet as the pointer travels up", () => {
    expect(
      dragHeightPx({
        startHeightPx: 200,
        deltaPx: 50,
        expandedHeightPx: EXPANDED,
      }),
    ).toBe(250);
  });

  it("shrinks it as the pointer travels down", () => {
    expect(
      dragHeightPx({
        startHeightPx: 200,
        deltaPx: -50,
        expandedHeightPx: EXPANDED,
      }),
    ).toBe(150);
  });

  it("stops at nothing rather than going negative", () => {
    // A negative height is not a height. The sheet is pinned to the bottom of
    // the viewport, so there is nowhere below zero to drag it to.
    expect(
      dragHeightPx({
        startHeightPx: 100,
        deltaPx: -500,
        expandedHeightPx: EXPANDED,
      }),
    ).toBe(0);
  });

  it("stops at the expanded height rather than overshooting", () => {
    // `h-mobile-sheet` already leaves the strip of map the design keeps
    // visible above the sheet; there is nothing further up to reveal. A
    // rubber-band overshoot would need a device to tune and is not asked for.
    expect(
      dragHeightPx({
        startHeightPx: 300,
        deltaPx: 500,
        expandedHeightPx: EXPANDED,
      }),
    ).toBe(EXPANDED);
  });

  it("holds still for a zero-length drag", () => {
    expect(
      dragHeightPx({
        startHeightPx: 200,
        deltaPx: 0,
        expandedHeightPx: EXPANDED,
      }),
    ).toBe(200);
  });
});

describe("handleBottomPx", () => {
  /**
   * SCRUM-529's regression. The table mirrors the resting classes in
   * `HANDLE_POSITION_CLASSES` (`src/pages/index.tsx`) at the same NAV,
   * expanded height and lift used elsewhere in this file - a NAV of 60, an
   * expanded height of 400 and, at a 16px root, an 8px lift. Before the fix
   * every row here was off by exactly that 8px: `collapsed` low, `half` and
   * `expanded` high.
   */
  const NAV = 60;
  const LIFT = 8;

  const bottomAt = (heightPx: number) =>
    handleBottomPx({ sheetBottomInsetPx: NAV, heightPx, liftPx: LIFT });

  it("matches each detent's resting bottom, with no discontinuity on release", () => {
    // Resting values, composed the same way `tailwind.config.js` composes
    // them: `bottom-above-mobile-nav` is NAV + LIFT; `bottom-half-sheet-handle`
    // and `bottom-sheet-handle` are NAV + height - LIFT.
    expect(
      bottomAt(
        detentHeightPx({ detent: "collapsed", expandedHeightPx: EXPANDED }),
      ),
    ).toBe(NAV + LIFT);
    expect(
      bottomAt(detentHeightPx({ detent: "half", expandedHeightPx: EXPANDED })),
    ).toBe(NAV + EXPANDED / 2 - LIFT);
    expect(
      bottomAt(
        detentHeightPx({ detent: "expanded", expandedHeightPx: EXPANDED }),
      ),
    ).toBe(NAV + EXPANDED - LIFT);
  });

  it("floors at collapsed's clearance rather than dipping below it", () => {
    // Below twice the lift (16px) of travel, `NAV + heightPx - LIFT` would
    // undercut the navigation clearance `collapsed` rests at; the floor holds
    // the pill there instead of letting it dip beneath it.
    expect(bottomAt(0)).toBe(NAV + LIFT);
    expect(bottomAt(4)).toBe(NAV + LIFT);
    expect(bottomAt(2 * LIFT)).toBe(NAV + LIFT);
  });

  it("rides the sheet's edge, less the lift, past the floor", () => {
    // One pixel beyond where the floor and the unclamped formula meet, the
    // formula is back in charge - continuously, with no jump at the seam.
    expect(bottomAt(2 * LIFT + 1)).toBe(NAV + 2 * LIFT + 1 - LIFT);
    expect(bottomAt(300)).toBe(NAV + 300 - LIFT);
  });
});

describe("snapToDetent", () => {
  it("lands on the detent the sheet was released nearest", () => {
    expect(snap(0)).toBe("collapsed");
    expect(snap(30)).toBe("collapsed");
    expect(snap(180)).toBe("half");
    expect(snap(220)).toBe("half");
    expect(snap(380)).toBe("expanded");
    expect(snap(EXPANDED)).toBe("expanded");
  });

  it("resolves a tie upwards", () => {
    // 100 is equidistant from collapsed (0) and half (200); 300 from half and
    // expanded. The taller detent wins both, because `collapsed` hides the
    // list completely - guessing it wrongly costs the user the thing they were
    // dragging towards, and a second gesture to get it back.
    expect(snap(100)).toBe("half");
    expect(snap(300)).toBe("expanded");
  });

  it("is reachable at every detent, so none is a dead option", () => {
    // A detent no release can land on is a height the sheet can never rest at
    // by gesture, which would make the drag a two-state control wearing three
    // states.
    const reached = new Set<SheetDetent>();
    for (let height = 0; height <= EXPANDED; height += 1) {
      reached.add(snap(height));
    }

    expect([...reached].sort()).toEqual(["collapsed", "expanded", "half"]);
  });

  it("never returns a detent taller than the sheet was dragged to, by more than half a step", () => {
    // The property behind the boundaries above, stated once rather than as a
    // list of sample heights: a snap moves the sheet by at most half the gap
    // between two detents, so it can never feel like the sheet ignored the
    // gesture.
    const step = EXPANDED / 2;

    for (let height = 0; height <= EXPANDED; height += 1) {
      const landed = detentHeightPx({
        detent: snap(height),
        expandedHeightPx: EXPANDED,
      });

      expect(Math.abs(landed - height)).toBeLessThanOrEqual(step / 2);
    }
  });

  it("does not crash on an unmeasured sheet", () => {
    // `useSheetDrag` refuses to begin a drag without a measurement, so this
    // should be unreachable - asserted rather than trusted, because the
    // fallback if it ever is reached must not be an exception in a pointer
    // handler.
    expect(snapToDetent({ heightPx: 0, expandedHeightPx: 0 })).toBe("expanded");
  });
});
