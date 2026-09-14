import { Role } from "@prisma/client";
import {
  defaultSheetDetent,
  detentHeightPx,
  dragHeightPx,
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
