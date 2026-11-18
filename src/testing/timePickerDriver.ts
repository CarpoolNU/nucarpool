import { act, fireEvent } from "@testing-library/react";

/**
 * Drives antd's `TimePicker` panel the way a person does: open it, click real
 * hour / minute / AM-PM cells, close it.
 *
 * Two things about antd 6's picker decide how, both measured in this jsdom:
 *
 *  - **A pick is committed when the popup closes, not when a cell is clicked.**
 *    A time picker is a "complex picker" to `@rc-component/picker`, so
 *    `needConfirm={false}` does not confirm on click; the input previews the
 *    value and the form sees nothing until the panel closes. Blurring the input
 *    closes it and commits; Escape closes it and **discards** the pick.
 *  - **The picker defers its open state**, so each step waits out a short real
 *    timer inside `act`. Shorter flushes gave results that flipped between runs.
 *
 * jsdom has no `ResizeObserver`, which the panel needs as soon as it opens;
 * `installResizeObserverStub` provides an inert one.
 */

export const installResizeObserverStub = () => {
  if (typeof globalThis.ResizeObserver === "function") {
    return;
  }

  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

/**
 * The open panel. Every picker that has ever opened keeps its popup in the
 * document, hidden, so the visible one is the one without the hidden class.
 */
const openPanel = (): Element => {
  const visible = Array.from(
    document.querySelectorAll(".ant-picker-dropdown"),
  ).filter((dropdown) => !dropdown.className.includes("-hidden"));

  if (visible.length !== 1) {
    throw new Error(`Expected one open time panel, found ${visible.length}`);
  }

  return visible[0]!;
};

const COLUMN = { hour: 0, minute: 1, meridiem: 2 } as const;
type Column = keyof typeof COLUMN;

const cellsOf = (column: Column): HTMLElement[] =>
  Array.from(
    openPanel()
      .querySelectorAll(".ant-picker-time-panel-column")
      [COLUMN[column]]!.querySelectorAll<HTMLElement>("li"),
  );

export const openTimePicker = async (input: HTMLElement) => {
  fireEvent.mouseDown(input);
  fireEvent.click(input);
  fireEvent.focus(input);
  await settle();
};

/**
 * Closes the panel by leaving the input, which commits the previewed pick.
 *
 * A real `blur()` rather than a dispatched blur event: the picker focuses its
 * own input when opened, and a synthetic event leaves it as
 * `document.activeElement`, so the next real focus change - a modal's
 * `autoFocus`, say - would deliver a second, stray blur.
 */
export const closeTimePicker = async (input: HTMLElement) => {
  await act(async () => {
    input.blur();
  });
  await settle();
};

/** Clicks one cell of the open panel - for a test that interleaves other work. */
export const clickTimeCell = async (column: Column, text: string) => {
  const cell = cellsOf(column).find((li) => li.textContent === text);

  if (!cell) {
    throw new Error(`No "${text}" cell in the ${column} column`);
  }

  fireEvent.click(cell.querySelector(".ant-picker-time-panel-cell-inner")!);
  await settle();
};

/** The highlighted cell in each column of the open panel, e.g. `["05", "00", "PM"]`. */
export const highlightedCells = (): string[] =>
  (Object.keys(COLUMN) as Column[]).map(
    (column) =>
      cellsOf(column).find((li) => li.className.includes("-selected"))
        ?.textContent ?? "",
  );

/**
 * Picks a time. Only `hour` is required: leaving out `meridiem` is the
 * hour-only pick SCRUM-732 is about, and whatever the panel was seeded with
 * decides the AM/PM it gets.
 */
export const pickTime = async (
  input: HTMLElement,
  pick: { hour: string; minute?: string; meridiem?: "AM" | "PM" },
) => {
  await openTimePicker(input);
  await clickTimeCell("hour", pick.hour);
  if (pick.minute) {
    await clickTimeCell("minute", pick.minute);
  }
  if (pick.meridiem) {
    await clickTimeCell("meridiem", pick.meridiem);
  }
  await closeTimePicker(input);
};
