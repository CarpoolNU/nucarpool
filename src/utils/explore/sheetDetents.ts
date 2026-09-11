/**
 * Where the mobile explore sheet can come to rest, and what a drag on its
 * handle resolves to.
 *
 * The handle is drawn as a grabber pill — 8×80px, rounded, centred on the top
 * edge of a rounded sheet — which is the standard iOS and Android "drag me"
 * affordance, reinforced by `cursor-pointer`. It was a `<button>` with nothing
 * but `onClick`, and the repository contained no touch or pointer handling at
 * all, so the first thing a user tried failed silently. The product owner
 * reported it as "I can't slide the tab up and down, instead I have to click
 * it then it goes down."
 *
 * Two detents make a drag pointless — anywhere you release, you get what a tap
 * would have given you — so `half` exists to give the gesture somewhere to
 * land. It is the only new state; `collapsed` and `expanded` are the two that
 * were always there, with the heights they always had.
 *
 * **Everything here is pure, and that is deliberate.** The gesture itself
 * cannot be tested in this repository: jsdom does no layout, every element
 * measures zero, and synthetic pointer events prove a handler is wired and
 * nothing more (see `src/testing/viewport.ts`). So the arithmetic that decides
 * where a release lands is separated from the DOM plumbing in `useSheetDrag`,
 * where it can be stated as a table — the same split `planExploreSidebar` and
 * `messageHeaderControls` already use, and for the same reason.
 */

/**
 * The sheet's resting positions.
 *
 * One value, not two booleans: `isCollapsed` plus an `isHalf` could encode
 * "collapsed and half at once", and the page would then need a rule for which
 * one wins. `planExploreSidebar` maps this union straight onto its own view
 * union, so a detent added here without classes to render it is a type error
 * at the page.
 */
export type SheetDetent = "collapsed" | "half" | "expanded";

/**
 * Each detent's height, as a fraction of the sheet's expanded height.
 *
 * Fractions rather than pixels because the expanded height is a CSS `calc()`
 * against the viewport and the safe-area inset (`h-mobile-sheet` in
 * `tailwind.config.js`). The drag measures that at gesture start and scales
 * these; nothing here duplicates a layout constant.
 */
const DETENT_FRACTION: Record<SheetDetent, number> = {
  collapsed: 0,
  half: 0.5,
  expanded: 1,
};

/** Ascending by height, which is the order `snapToDetent` walks. */
const DETENTS_BY_HEIGHT: readonly SheetDetent[] = [
  "collapsed",
  "half",
  "expanded",
];

/**
 * How far a pointer may travel and still be a tap.
 *
 * A finger never holds still, so without a threshold every tap would register
 * as a one-pixel drag, snap back to the detent it started from, and the tap
 * would appear to do nothing — which is the bug this ticket is about, merely
 * relocated. 8px is the usual slop for this; it is under half the pill's 20px
 * height, so it cannot be reached by a deliberate press.
 */
export const TAP_SLOP_PX = 8;

/** Whether a gesture that moved this far vertically counts as a tap. */
export const isTap = (deltaPx: number): boolean =>
  Math.abs(deltaPx) <= TAP_SLOP_PX;

/**
 * What a tap does, unchanged from before the sheet could be dragged.
 *
 * Deliberately *not* a three-way cycle. Tapping used to flip between the two
 * states and the label says as much — "Show the list" / "Hide the list" — so a
 * tap from `half` collapses, because anything other than `collapsed` reads as
 * open and the control offers to close it.
 */
export const toggleSheetDetent = (detent: SheetDetent): SheetDetent =>
  detent === "collapsed" ? "expanded" : "collapsed";

/** The pixel height of a detent, given the sheet's measured expanded height. */
export const detentHeightPx = ({
  detent,
  expandedHeightPx,
}: {
  detent: SheetDetent;
  expandedHeightPx: number;
}): number => DETENT_FRACTION[detent] * expandedHeightPx;

/**
 * Where the sheet's top edge sits mid-drag: the height it started at, plus
 * however far the pointer has travelled upwards, bounded by the sheet's own
 * range.
 *
 * Clamped rather than allowed to overshoot, because there is nothing above the
 * expanded height to show — the sheet is pinned to the bottom of the viewport
 * and `h-mobile-sheet` already reaches the strip of map the design keeps
 * visible. A rubber-band overshoot would need a real device to tune and is not
 * what the ticket asks for.
 */
export const dragHeightPx = ({
  startHeightPx,
  deltaPx,
  expandedHeightPx,
}: {
  startHeightPx: number;
  /** Pointer travel, positive upwards — the direction that grows the sheet. */
  deltaPx: number;
  expandedHeightPx: number;
}): number => Math.min(Math.max(startHeightPx + deltaPx, 0), expandedHeightPx);

/**
 * The detent a release lands on: whichever is nearest the height the sheet was
 * dragged to.
 *
 * **Ties resolve upwards.** At exactly a quarter of the expanded height the
 * release is equidistant from `collapsed` and `half`, and the taller of the
 * two is the safer error: `collapsed` hides the list completely, so guessing
 * it wrongly costs the user the thing they were dragging towards.
 *
 * A zero or negative `expandedHeightPx` means nothing was measured, and every
 * detent is then zero pixels tall; the ascending walk returns `expanded` for
 * that, which is the harmless end of a state that `useSheetDrag` refuses to
 * start a drag in anyway.
 */
export const snapToDetent = ({
  heightPx,
  expandedHeightPx,
}: {
  heightPx: number;
  expandedHeightPx: number;
}): SheetDetent =>
  DETENTS_BY_HEIGHT.reduce((nearest, detent) => {
    const distance = Math.abs(
      heightPx - detentHeightPx({ detent, expandedHeightPx }),
    );
    const nearestDistance = Math.abs(
      heightPx - detentHeightPx({ detent: nearest, expandedHeightPx }),
    );

    // `<=` is what makes a tie resolve upwards: the walk is ascending, so the
    // later - taller - detent replaces an equally close earlier one.
    return distance <= nearestDistance ? detent : nearest;
  }, DETENTS_BY_HEIGHT[0]);
