import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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
 *  - with nothing measured the handle degrades to tap-only rather than
 *    dragging against a zero-height range;
 *  - keyboard activation reaches the tap path, since a `click` with no pointer
 *    sequence must not be mistaken for the end of a drag.
 *
 * The rect below is the stub that makes any of it possible: a sheet 400px tall
 * whose bottom edge sits 700px down a 768px-tall jsdom viewport. Detents are
 * therefore 0, 200 and 400.
 */

const EXPANDED_HEIGHT = 400;
const SHEET_BOTTOM_Y = 700;

/** The sheet's current height, which the stubbed rect reports. */
let sheetHeightPx = EXPANDED_HEIGHT;

const rectStub = () =>
  ({
    height: sheetHeightPx,
    bottom: SHEET_BOTTOM_Y,
    top: SHEET_BOTTOM_Y - sheetHeightPx,
    left: 0,
    right: 400,
    width: 400,
    x: 0,
    y: SHEET_BOTTOM_Y - sheetHeightPx,
    toJSON: () => ({}),
  }) as DOMRect;

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  sheetHeightPx = EXPANDED_HEIGHT;
  Element.prototype.getBoundingClientRect = rectStub;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
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

    gesture(handle, { from: 300, to: 660 });

    expect(onDetentChange).toHaveBeenCalledWith("collapsed");
  });

  it("expands from a collapsed sheet, using the height last measured", () => {
    // The case that needs the cache: the sheet measures zero while collapsed,
    // so the drag's range has to come from the last expanded render. Without
    // it there would be no range and no drag - which is why the hook keeps the
    // measurement rather than reading the element it is about to resize.
    const { handle, onDetentChange, rerender } = setup("expanded");

    sheetHeightPx = 0;
    rerender("collapsed");

    // Up 380px from nothing: nearest expanded (400).
    gesture(handle, { from: 600, to: 220 });

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
    // 68px of viewport below the sheet's bottom edge (768 - 700), plus the
    // 300px the sheet now stands at: the pill rides the top edge.
    expect(handle.style.bottom).toBe("368px");
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

describe("an unmeasured sheet", () => {
  it("refuses to drag, and still taps", () => {
    // No expanded render has happened, so there is no range to drag within.
    // Degrading to the tap the control has always had is the right failure;
    // dragging against a zero range would snap to a detent chosen by
    // arithmetic over nothing.
    sheetHeightPx = 0;
    const { handle, onTap, onDetentChange, sheet } = setup("collapsed");

    gesture(handle, { from: 600, to: 300 });

    expect(onDetentChange).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(sheet.style.height).toBe("");
    expect(handle).toHaveTextContent("resting");
  });

  it("ignores a measurement taken while the sheet is not expanded", () => {
    // `detail` is a different fixed height and `hidden` is `display: none`,
    // which measures zero. Caching either would put the drag's range at the
    // wrong end of the sheet.
    sheetHeightPx = 320;
    const { handle, onDetentChange } = setup("detail");

    gesture(handle, { from: 600, to: 300 });

    expect(onDetentChange).not.toHaveBeenCalled();
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
