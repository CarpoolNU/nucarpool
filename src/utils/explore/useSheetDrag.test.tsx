import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MOBILE_SHEET_MAP_STRIP_REM } from "../breakpoints";
import { useSheetDrag } from "./useSheetDrag";
import type { ExploreSidebarView } from "./exploreSidebarView";
import type { SheetDetent } from "./sheetDetents";

/**
 * The wiring behind the explore sheet's drag handle.
 *
 * **Read this before trusting it.** jsdom does no layout: every element
 * measures zero, there is no compositor, and `fireEvent.pointerMove` is a
 * synthetic event with numbers attached rather than a finger. So nothing here
 * shows that the sheet follows a thumb, that it feels right, or that the
 * browser does not claim the gesture first — that last one is `touch-action`,
 * which jsdom does not implement at all. `src/testing/viewport.ts` sets out
 * what this environment can and cannot answer; the ticket requires a manual
 * pass on a real device, and the PR records it.
 *
 * What these tests *do* cover is every branch that can silently lose the
 * feature:
 *
 *  - a tap still toggles, which is the behaviour the control has always had
 *    and the one a drag implementation is most likely to swallow;
 *  - the click that follows a drag does **not** also toggle, or releasing at
 *    `half` would be collapsed a moment later by the tap handler;
 *  - a release lands on a detent, and a cancel lands on none;
 *  - a drag begins from a *collapsed* sheet with no expanded render behind it,
 *    which is the regression SCRUM-459 fixed and the one this environment can
 *    genuinely speak to, since the range is now arithmetic over a measured
 *    edge rather than a cached measurement;
 *  - a sheet with no geometry, or a view that is not a detent, degrades to
 *    tap-only rather than dragging against a zero-height range;
 *  - keyboard activation reaches the tap path, since a `click` with no pointer
 *    sequence must not be mistaken for the end of a drag.
 *
 * ---
 *
 * **The geometry below is a whole phone, not just a sheet**, because the drag's
 * range is now derived from the viewport rather than read off the sheet. A
 * 548px-tall viewport with a 60px navigation puts the sheet's pinned bottom
 * edge at 488, and the 5.5rem map strip above it — 88px at the 16px root font
 * size jsdom forces the hook to fall back to — leaves an expanded height of
 * 400. So the detents are 0, 200 and 400, the same three the assertions below
 * were written against before the range moved.
 *
 * Every figure is derived rather than typed in, so a change to the map strip
 * re-derives the expectations instead of silently invalidating them.
 */

/**
 * jsdom returns the empty string for `getComputedStyle(:root).fontSize`, so the
 * hook falls back to 16 — the CSS initial value. Stated here because the strip
 * below depends on it and it is not a choice this file gets to make.
 */
const ROOT_FONT_SIZE_PX = 16;

/** 5.5rem of map left visible above an expanded sheet: 88px. */
const MAP_STRIP_PX = MOBILE_SHEET_MAP_STRIP_REM * ROOT_FONT_SIZE_PX;

const VIEWPORT_HEIGHT = 548;
const NAV_SPACE = 60;

/** Where `bottom-mobile-nav` pins the sheet, in every detent: 488. */
const SHEET_BOTTOM_Y = VIEWPORT_HEIGHT - NAV_SPACE;

/** What the hook should derive from that edge: 400. */
const EXPANDED_HEIGHT = SHEET_BOTTOM_Y - MAP_STRIP_PX;

/** The sheet's current height, which the stubbed rect reports. */
let sheetHeightPx = EXPANDED_HEIGHT;

/**
 * The sheet's bottom edge. A `let` because the one thing that moves it is the
 * sheet leaving layout entirely, which is what `display: none` does and what
 * the degradation test needs.
 */
let sheetBottomPx = SHEET_BOTTOM_Y;

const rectStub = () =>
  ({
    height: sheetHeightPx,
    bottom: sheetBottomPx,
    top: sheetBottomPx - sheetHeightPx,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: sheetBottomPx - sheetHeightPx,
    toJSON: () => ({}),
  }) as DOMRect;

const originalRect = Element.prototype.getBoundingClientRect;
const originalInnerHeight = window.innerHeight;

const setViewportHeight = (height: number) => {
  Object.defineProperty(window, "innerHeight", {
    value: height,
    writable: true,
    configurable: true,
  });
};

beforeEach(() => {
  sheetHeightPx = EXPANDED_HEIGHT;
  sheetBottomPx = SHEET_BOTTOM_Y;
  setViewportHeight(VIEWPORT_HEIGHT);
  Element.prototype.getBoundingClientRect = rectStub;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  setViewportHeight(originalInnerHeight);
});

/**
 * A pointer event this environment can actually carry.
 *
 * **jsdom 26 has no `PointerEvent` constructor** - `typeof
 * window.PointerEvent` is `"undefined"` here, measured rather than assumed. So
 * `fireEvent.pointerDown(el, { clientY: 300 })` falls back to a bare `Event`
 * and **drops `clientY` on the floor**. Every drag below then computed `NaN`,
 * wrote an invalid height the DOM discarded, and snapped to `collapsed` - a
 * suite that looked like it was exercising a gesture while asserting nothing
 * about one. Two of these tests passed in that state, which is the part worth
 * remembering.
 *
 * `MouseEvent` *is* implemented and carries `clientY`, and React dispatches by
 * event **name**, so an event called `pointerdown` reaches `onPointerDown`
 * whatever class produced it. `pointerId` is defined onto the instance
 * afterwards, since `MouseEvent` has no such field.
 */
const pointer = (
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  { clientY, pointerId = 1 }: { clientY: number; pointerId?: number },
) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientY,
  });

  Object.defineProperty(event, "pointerId", { value: pointerId });

  return event;
};

const Harness = ({
  view,
  onDetentChange,
  onTap,
}: {
  view: ExploreSidebarView;
  onDetentChange: (detent: SheetDetent) => void;
  onTap: () => void;
}) => {
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag({ sheetRef, view, onDetentChange, onTap });

  return (
    <>
      <div data-testid="sheet" ref={sheetRef} />
      <button type="button" data-testid="handle" {...drag.handleProps}>
        {drag.isDragging ? "dragging" : "resting"}
      </button>
    </>
  );
};

const setup = (view: ExploreSidebarView = "expanded") => {
  const onDetentChange = jest.fn();
  const onTap = jest.fn();
  const rendered = render(
    <Harness view={view} onDetentChange={onDetentChange} onTap={onTap} />,
  );

  return {
    onDetentChange,
    onTap,
    rerender: (nextView: ExploreSidebarView) =>
      rendered.rerender(
        <Harness
          view={nextView}
          onDetentChange={onDetentChange}
          onTap={onTap}
        />,
      ),
    handle: screen.getByTestId("handle"),
    sheet: screen.getByTestId("sheet"),
  };
};

/** One whole gesture: down, some number of moves, up, and the click after it. */
const gesture = (
  handle: HTMLElement,
  { from, to }: { from: number; to: number },
) => {
  fireEvent(handle, pointer("pointerdown", { clientY: from }));
  fireEvent(handle, pointer("pointermove", { clientY: to }));
  fireEvent(handle, pointer("pointerup", { clientY: to }));
  // The browser sends this after `pointerup` on the same element, whether the
  // gesture was a tap or a drag. Suppressing it for a drag is the hook's job.
  fireEvent.click(handle);
};

describe("a tap", () => {
  it("reaches the tap handler and moves no detent", () => {
    const { handle, onTap, onDetentChange } = setup();

    // Two pixels of travel: a finger, not a drag.
    gesture(handle, { from: 400, to: 398 });

    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it("still taps when the pointer never moves at all", () => {
    const { handle, onTap } = setup();

    fireEvent(handle, pointer("pointerdown", { clientY: 400, pointerId: 1 }));
    fireEvent(handle, pointer("pointerup", { clientY: 400, pointerId: 1 }));
    fireEvent.click(handle);

    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("leaves the sheet's height to its classes", () => {
    // A tap must not leave an inline height behind: the class-driven
    // transition is what animates the toggle, and an inline value would win
    // over it for the rest of the session.
    const { handle, sheet } = setup();

    gesture(handle, { from: 400, to: 398 });

    expect(sheet.style.height).toBe("");
  });
});

describe("a drag", () => {
  it("lands on the detent nearest where it was released", () => {
    const { handle, onDetentChange } = setup();

    // From the expanded sheet, 220px down the screen: 400 - 220 = 180, which
    // is nearest half (200).
    gesture(handle, { from: 300, to: 520 });

    expect(onDetentChange).toHaveBeenCalledWith("half");
  });

  it("collapses when dragged most of the way down", () => {
    const { handle, onDetentChange } = setup();

    // The pill starts near the sheet's top edge on an expanded sheet and is
    // pulled down to just above the navigation: 340px of travel from 400
    // leaves 60, nearest collapsed (0).
    gesture(handle, { from: 100, to: 440 });

    expect(onDetentChange).toHaveBeenCalledWith("collapsed");
  });

  it("expands from a collapsed sheet on the very first gesture", () => {
    // **SCRUM-459.** A VIEWER's sheet opens `collapsed`, so this is that role's
    // first touch of the handle in a session - no expanded render has ever
    // happened. The sheet itself measures zero here, and that no longer
    // matters: the range comes from the bottom edge the sheet is pinned to,
    // which is the same in every detent.
    sheetHeightPx = 0;
    const { handle, onDetentChange } = setup("collapsed");

    // Up 340px from nothing: nearest expanded (400).
    gesture(handle, { from: 440, to: 100 });

    expect(onDetentChange).toHaveBeenCalledWith("expanded");
  });

  it("uses the same range after the sheet has been collapsed by hand", () => {
    // The other half of the criterion: a RIDER or DRIVER who collapses the
    // sheet themselves must still be able to drag it back open, and the range
    // must not have shrunk to the collapsed sheet's zero height.
    const { handle, onDetentChange, rerender } = setup("expanded");

    sheetHeightPx = 0;
    rerender("collapsed");

    gesture(handle, { from: 440, to: 100 });

    expect(onDetentChange).toHaveBeenCalledWith("expanded");
  });

  it("drags against the viewport it is in, not the one it last saw", () => {
    // The staleness the old cache carried: rotating with the sheet closed left
    // the previous viewport's range in a ref, because only an expanded render
    // refreshed it. Nothing is kept between gestures now, so a shorter
    // viewport is simply a shorter range - here 288, whose detents are 0, 144
    // and 288 rather than 0, 200 and 400.
    const { handle, onDetentChange, rerender } = setup("expanded");

    sheetHeightPx = 0;
    rerender("collapsed");

    setViewportHeight(436);
    sheetBottomPx = 436 - NAV_SPACE;

    // Up 230px from nothing. In the new range that is nearest expanded (288);
    // measured against the taller viewport's stale 400 it would have been
    // nearest half (200) - so this asserts which range was used, not merely
    // that some drag happened.
    gesture(handle, { from: 300, to: 70 });

    expect(onDetentChange).toHaveBeenCalledWith("expanded");
  });

  it("does not also fire the tap handler", () => {
    // The regression that would make this feature worse than no feature:
    // `click` follows `pointerup`, so a drag released at half would be
    // collapsed again by the toggle a moment later.
    const { handle, onTap, onDetentChange } = setup();

    gesture(handle, { from: 300, to: 520 });

    expect(onDetentChange).toHaveBeenCalledTimes(1);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("taps again on the next gesture, having suppressed one click", () => {
    // The suppression is one-shot. A flag left set would make the handle
    // permanently untappable after any drag.
    const { handle, onTap } = setup();

    gesture(handle, { from: 300, to: 520 });
    gesture(handle, { from: 400, to: 399 });

    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("writes the sheet's height and the handle's position while in flight", () => {
    // The imperative half of the hook, and the reason it is imperative: this
    // runs on every pointer move, and routing it through React state would
    // re-render the whole explore page at pointer frequency.
    const { handle, sheet } = setup();

    fireEvent(handle, pointer("pointerdown", { clientY: 300, pointerId: 1 }));
    fireEvent(handle, pointer("pointermove", { clientY: 400, pointerId: 1 }));

    expect(sheet.style.height).toBe("300px");
    // 60px of viewport below the sheet's bottom edge - the navigation - plus
    // the 300px the sheet now stands at: the pill rides the top edge.
    expect(handle.style.bottom).toBe(`${NAV_SPACE + 300}px`);
    expect(handle).toHaveTextContent("dragging");
  });

  it("hands both back to their classes on release", () => {
    const { handle, sheet } = setup();

    gesture(handle, { from: 300, to: 520 });

    expect(sheet.style.height).toBe("");
    expect(handle.style.bottom).toBe("");
    expect(handle).toHaveTextContent("resting");
  });

  it("never drags the sheet past its own range", () => {
    // Clamped, so a long swipe cannot leave the sheet taller than the space
    // the design reserves for it or shorter than nothing.
    const { handle, sheet } = setup();

    fireEvent(handle, pointer("pointerdown", { clientY: 300, pointerId: 1 }));
    fireEvent(handle, pointer("pointermove", { clientY: -2000, pointerId: 1 }));
    expect(sheet.style.height).toBe(`${EXPANDED_HEIGHT}px`);

    fireEvent(handle, pointer("pointermove", { clientY: 2000, pointerId: 1 }));
    expect(sheet.style.height).toBe("0px");
  });
});

describe("a cancelled pointer", () => {
  it("moves no detent", () => {
    // The browser taking the gesture over is not a decision the user made, so
    // it must not move the sheet.
    const { handle, onDetentChange, onTap } = setup();

    fireEvent(handle, pointer("pointerdown", { clientY: 300, pointerId: 1 }));
    fireEvent(handle, pointer("pointermove", { clientY: 520, pointerId: 1 }));
    fireEvent(handle, pointer("pointercancel", { clientY: 520, pointerId: 1 }));

    expect(onDetentChange).not.toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });

  it("puts the sheet back under its classes", () => {
    const { handle, sheet } = setup();

    fireEvent(handle, pointer("pointerdown", { clientY: 300, pointerId: 1 }));
    fireEvent(handle, pointer("pointermove", { clientY: 520, pointerId: 1 }));
    fireEvent(handle, pointer("pointercancel", { clientY: 520, pointerId: 1 }));

    expect(sheet.style.height).toBe("");
    expect(handle.style.bottom).toBe("");
    expect(handle).toHaveTextContent("resting");
  });
});

describe("a sheet with no range", () => {
  it("refuses to drag, and still taps", () => {
    // A sheet out of layout reports a rect of zeros, so its bottom edge is
    // above the map strip and the range comes out as nothing. Degrading to the
    // tap the control has always had is the right failure; dragging against a
    // zero range would snap to a detent chosen by arithmetic over nothing.
    sheetHeightPx = 0;
    sheetBottomPx = 0;
    const { handle, onTap, onDetentChange, sheet } = setup("collapsed");

    gesture(handle, { from: 440, to: 100 });

    expect(onDetentChange).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(sheet.style.height).toBe("");
    expect(handle).toHaveTextContent("resting");
  });

  it("refuses in a view that is not a detent", () => {
    // `detail` is a *different* sheet - a fixed 320px capped at `60dvh` -
    // pinned to the same bottom edge, so the range derived from that edge is
    // several times its height and a drag would resize it to something the
    // view has no classes for. The handle is not rendered there, so this is
    // the second statement of that rule rather than the only one.
    sheetHeightPx = 320;
    const { handle, onDetentChange, onTap } = setup("detail");

    gesture(handle, { from: 440, to: 100 });

    expect(onDetentChange).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe("keyboard activation", () => {
  it("toggles, since a click with no pointer sequence is not a drag", () => {
    // Enter or Space on a focused handle produces a bare `click`. If the
    // drag-suppression flag were anything but per-gesture this would be the
    // path that broke.
    const { handle, onTap } = setup();

    fireEvent.click(handle);

    expect(onTap).toHaveBeenCalledTimes(1);
  });
});

describe("a second pointer", () => {
  it("is ignored while one is already dragging", () => {
    // Two fingers on one handle. The gesture belongs to the pointer that
    // started it; the other must not drive the sheet or end the drag.
    const { handle, onDetentChange, sheet } = setup();

    fireEvent(handle, pointer("pointerdown", { clientY: 300, pointerId: 1 }));
    fireEvent(handle, pointer("pointermove", { clientY: 400, pointerId: 1 }));

    fireEvent(handle, pointer("pointermove", { clientY: 650, pointerId: 2 }));
    expect(sheet.style.height).toBe("300px");

    fireEvent(handle, pointer("pointerup", { clientY: 650, pointerId: 2 }));
    expect(onDetentChange).not.toHaveBeenCalled();

    fireEvent(handle, pointer("pointerup", { clientY: 350, pointerId: 1 }));
    expect(onDetentChange).toHaveBeenCalledWith("expanded");
  });
});
