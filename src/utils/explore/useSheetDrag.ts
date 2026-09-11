import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import type { ExploreSidebarView } from "./exploreSidebarView";
import {
  dragHeightPx,
  isTap,
  snapToDetent,
  type SheetDetent,
} from "./sheetDetents";

/**
 * Dragging the mobile explore sheet by its handle.
 *
 * The handle looked draggable and was not: an 8×80px grabber pill with nothing
 * but `onClick` behind it, in a repository that contained no touch or pointer
 * handling anywhere. This hook is the gesture; `sheetDetents.ts` is the
 * arithmetic it defers to, and that split is where the testable half lives.
 *
 * **Pointer events rather than touch events**, so the same code path serves a
 * mouse, a stylus and a finger, and `setPointerCapture` keeps delivering moves
 * after the finger leaves the 44px handle — which it will, since the gesture is
 * most of the height of the screen.
 *
 * **The list underneath cannot be scrolled by this gesture, structurally.** The
 * handle is a sibling of the sheet, not a child of it, so a drag that starts on
 * the handle never reaches the sheet's `overflow-y-auto`. `touch-action: none`
 * on the handle is the second half of that: without it the browser may claim a
 * vertical swipe for the page before the handler sees it.
 *
 * ---
 *
 * **Why this writes `style.height` on the element instead of rendering it.**
 * A React state update per `pointermove` would re-render `index.tsx` — Mapbox,
 * the card lists, every sidebar row — at pointer frequency, which is the one
 * thing a drag cannot afford. So the height is written straight to the node,
 * and React is told only that a drag is in progress.
 *
 * That is the same *technique* the sidebar's old imperative `classList` calls
 * used, and those were a bug, so the difference matters: React owns the
 * sheet's `class` attribute and reassigns the whole of it on any re-render,
 * which is exactly how `classList.add("hidden")` got wiped. It does **not**
 * own `style.height` here, because no render of this page ever puts `height`
 * in a `style` prop. React only removes style keys it previously set itself,
 * so nothing can clobber the drag mid-gesture, and clearing the property on
 * release hands the height back to the class.
 *
 * The handle's own `bottom` is written the same way and for the same reason,
 * so the pill rides the sheet's top edge instead of waiting at a detent.
 */

type UseSheetDragArgs = {
  /** The sheet. Its height is what a drag changes. */
  sheetRef: React.RefObject<HTMLElement | null>;
  /**
   * The view the page is currently rendering. Only `expanded` is a trustworthy
   * thing to measure: `detail` is a different fixed height and `hidden` is
   * `display: none`, which measures zero.
   */
  view: ExploreSidebarView;
  /** Where a released drag lands. */
  onDetentChange: (detent: SheetDetent) => void;
  /** What a tap does — the behaviour that existed before this hook. */
  onTap: () => void;
};

type SheetDragHandleProps = {
  onPointerDown: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerUp: React.PointerEventHandler<HTMLElement>;
  onPointerCancel: React.PointerEventHandler<HTMLElement>;
  onClick: React.MouseEventHandler<HTMLElement>;
};

type UseSheetDrag = {
  /**
   * True only between a pointer going down on the handle and a drag being
   * released. The page drops its height class and its transition while this
   * holds, so the sheet follows the pointer instead of animating towards a
   * detent it is no longer heading for.
   */
  isDragging: boolean;
  /** Spread onto the handle. */
  handleProps: SheetDragHandleProps;
};

/** What one in-flight gesture needs to remember. */
type Gesture = {
  pointerId: number;
  /** Viewport Y at `pointerdown`. */
  startY: number;
  /** The sheet's height at `pointerdown`, measured rather than inferred. */
  startHeightPx: number;
  /** The sheet's expanded height, i.e. the top of the drag's range. */
  expandedHeightPx: number;
  /** Distance from the bottom of the viewport to the sheet's bottom edge. */
  sheetBottomInsetPx: number;
  /** The handle, so the pill can ride the sheet's edge. */
  handle: HTMLElement;
  /** True once the pointer has travelled beyond the tap slop. */
  moved: boolean;
};

export const useSheetDrag = ({
  sheetRef,
  view,
  onDetentChange,
  onTap,
}: UseSheetDragArgs): UseSheetDrag => {
  const [isDragging, setIsDragging] = useState(false);
  const gestureRef = useRef<Gesture | null>(null);

  /**
   * The expanded height, in pixels, as last measured from a real expanded
   * render.
   *
   * Measured rather than computed: `h-mobile-sheet` is a `calc()` over the
   * viewport, a rem-based map strip and `env(safe-area-inset-bottom)`, so
   * reproducing it in JavaScript would mean duplicating three layout constants
   * and would be wrong on any device with a home indicator.
   *
   * The sheet renders expanded by default on mobile, so this is populated
   * before the handle can be touched. A viewport that resizes *while the sheet
   * is not expanded* leaves it stale until the next expanded render — the drag
   * then runs against the previous viewport's range. Rotating a phone with the
   * sheet collapsed is the way to see that; the `Math.min` against the space
   * actually available below keeps the consequence to a slightly short drag
   * rather than a sheet dragged off the screen.
   */
  const expandedHeightRef = useRef(0);

  useLayoutEffect(() => {
    if (view !== "expanded") {
      return;
    }

    const measure = () => {
      const height = sheetRef.current?.getBoundingClientRect().height ?? 0;

      // Zero means unmeasurable rather than measured-as-nothing - a detached
      // node, or jsdom, which reports zero for everything. Caching it would
      // disable dragging for the rest of the session.
      if (height > 0) {
        expandedHeightRef.current = height;
      }
    };

    measure();
    window.addEventListener("resize", measure);

    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [view, sheetRef]);

  /** Put the sheet and the handle back under the control of their classes. */
  const releaseStyles = useCallback(
    (gesture: Gesture) => {
      const sheet = sheetRef.current;

      if (sheet) {
        sheet.style.height = "";
      }

      gesture.handle.style.bottom = "";
    },
    [sheetRef],
  );

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => {
      const sheet = sheetRef.current;
      const expandedHeightPx = expandedHeightRef.current;

      // No measurement, no drag. Tapping still works, which is the behaviour
      // this control has always had - degrading to it is the right failure.
      if (!sheet || expandedHeightPx <= 0) {
        return;
      }

      const rect = sheet.getBoundingClientRect();
      const handle = event.currentTarget;

      gestureRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeightPx: rect.height,
        // The sheet cannot be taller than the space between its pinned bottom
        // edge and the top of the viewport, whatever was last measured.
        expandedHeightPx: Math.min(expandedHeightPx, rect.bottom),
        sheetBottomInsetPx: window.innerHeight - rect.bottom,
        handle,
        moved: false,
      };

      // Keeps `pointermove` coming once the finger leaves the handle, which is
      // most of the gesture. Optional-called because jsdom does not implement
      // it, and a wiring test should not have to.
      handle.setPointerCapture?.(event.pointerId);
      setIsDragging(true);
    },
    [sheetRef],
  );

  /** Where the drag currently stands, without touching React state. */
  const applyDragHeight = useCallback(
    (gesture: Gesture, clientY: number): number => {
      const sheet = sheetRef.current;
      // Up is positive: the direction that grows the sheet.
      const deltaPx = gesture.startY - clientY;
      const heightPx = dragHeightPx({
        startHeightPx: gesture.startHeightPx,
        deltaPx,
        expandedHeightPx: gesture.expandedHeightPx,
      });

      if (sheet) {
        sheet.style.height = `${heightPx}px`;
      }

      // The pill rides the sheet's top edge. Its resting positions are class
      // names measured from the same edge, so this is the same relationship
      // held continuously rather than a second one invented for the drag.
      gesture.handle.style.bottom = `${gesture.sheetBottomInsetPx + heightPx}px`;

      return heightPx;
    },
    [sheetRef],
  );

  const onPointerMove = useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => {
      const gesture = gestureRef.current;

      if (!gesture || gesture.pointerId !== event.pointerId) {
        return;
      }

      if (!isTap(gesture.startY - event.clientY)) {
        gesture.moved = true;
      }

      applyDragHeight(gesture, event.clientY);
    },
    [applyDragHeight],
  );

  /**
   * Whether the gesture that just ended was a drag.
   *
   * `click` fires after `pointerup` on the same element, so without this a
   * drag would also toggle the sheet — releasing at `half` and immediately
   * being collapsed by the tap handler. Read and cleared by `onClick`, and
   * left false by a keyboard activation, which produces a `click` with no
   * pointer sequence at all.
   */
  const draggedRef = useRef(false);

  const endGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
      const gesture = gestureRef.current;

      if (!gesture || gesture.pointerId !== event.pointerId) {
        return;
      }

      gestureRef.current = null;
      gesture.handle.releasePointerCapture?.(event.pointerId);

      const heightPx = commit
        ? applyDragHeight(gesture, event.clientY)
        : gesture.startHeightPx;

      draggedRef.current = commit && gesture.moved;
      releaseStyles(gesture);
      setIsDragging(false);

      if (draggedRef.current) {
        onDetentChange(
          snapToDetent({
            heightPx,
            expandedHeightPx: gesture.expandedHeightPx,
          }),
        );
      }
    },
    [applyDragHeight, releaseStyles, onDetentChange],
  );

  const onPointerUp = useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => {
      endGesture(event, true);
    },
    [endGesture],
  );

  /**
   * A cancelled pointer - the browser taking the gesture over, or the finger
   * being interrupted - leaves the sheet where it was. Committing a detent
   * here would move the sheet in response to something the user did not do.
   */
  const onPointerCancel = useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => {
      endGesture(event, false);
    },
    [endGesture],
  );

  const onClick = useCallback<React.MouseEventHandler<HTMLElement>>(() => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }

    onTap();
  }, [onTap]);

  return {
    isDragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClick,
    },
  };
};
