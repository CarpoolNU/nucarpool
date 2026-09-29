import { render, screen, within } from "@testing-library/react";
import DaysByWeekdayTable from "./DaysByWeekdayTable";
import { WEEKDAY_NAMES } from "../../utils/adminDashboardLabels";
import type { AdminDaysByWeekday } from "../../utils/types";

/**
 * The weekday table: the chart's numbers as text, and the rows an admin most
 * needs to see picked out. Real DOM, no stub - there is no canvas here.
 */

const DRIVERS = [0, 4, 5, 3, 2, 1, 0];
const RIDERS = [1, 9, 8, 0, 6, 7, 0];

const data = (unspecified = { drivers: 0, riders: 0 }): AdminDaysByWeekday => ({
  days: WEEKDAY_NAMES.map((day, index) => ({
    day,
    drivers: DRIVERS[index],
    riders: RIDERS[index],
    stranded: RIDERS[index] > 0 && DRIVERS[index] === 0,
  })),
  unspecified,
});

const rowFor = (day: string) =>
  screen.getByRole("row", { name: new RegExp(`^${day}`) });

const cellsOf = (row: HTMLElement) =>
  within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

describe("DaysByWeekdayTable", () => {
  it("has a header cell for every column, so a reader is told what each number is", () => {
    render(<DaysByWeekdayTable daysByWeekday={data()} />);

    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Day", "Drivers", "Riders", "Status"]);
  });

  it("writes each day's counts on its own row, drivers before riders", () => {
    render(<DaysByWeekdayTable daysByWeekday={data()} />);

    expect(cellsOf(rowFor("Monday"))).toEqual(["4", "9", ""]);
    expect(cellsOf(rowFor("Tuesday"))).toEqual(["5", "8", ""]);
  });

  it("has one row per weekday in order, then Unspecified, under the header row", () => {
    render(<DaysByWeekdayTable daysByWeekday={data()} />);

    const rows = screen.getAllByRole("row").slice(1);
    expect(
      rows.map((row) => within(row).getByRole("rowheader").textContent),
    ).toEqual([...WEEKDAY_NAMES, "Unspecified"]);
  });

  it("marks a day with riders and no driver in words, and no other", () => {
    render(<DaysByWeekdayTable daysByWeekday={data()} />);

    expect(within(rowFor("Sunday")).getByText("No driver")).toBeVisible();
    expect(screen.getAllByText("No driver")).toHaveLength(1);
  });

  it("does not mark a day nobody works as short of a driver", () => {
    render(<DaysByWeekdayTable daysByWeekday={data()} />);

    expect(cellsOf(rowFor("Saturday"))).toEqual(["0", "0", ""]);
  });

  it("writes the people who named no day on their own row, with no status", () => {
    render(
      <DaysByWeekdayTable daysByWeekday={data({ drivers: 2, riders: 5 })} />,
    );

    expect(cellsOf(rowFor("Unspecified"))).toEqual(["2", "5", ""]);
  });

  it("renders nothing when there is nobody, since the chart already says so", () => {
    const empty = data();
    const { container } = render(
      <DaysByWeekdayTable
        daysByWeekday={{
          ...empty,
          days: empty.days.map((row) => ({
            ...row,
            drivers: 0,
            riders: 0,
            stranded: false,
          })),
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("still renders when the only people there named no day", () => {
    const empty = data({ drivers: 0, riders: 3 });
    render(
      <DaysByWeekdayTable
        daysByWeekday={{
          ...empty,
          days: empty.days.map((row) => ({
            ...row,
            drivers: 0,
            riders: 0,
            stranded: false,
          })),
        }}
      />,
    );

    expect(cellsOf(rowFor("Unspecified"))).toEqual(["0", "3", ""]);
  });

  it("shows no time of day", () => {
    const { container } = render(<DaysByWeekdayTable daysByWeekday={data()} />);

    expect(container.textContent).not.toMatch(/\d:\d\d|\b(am|pm)\b|hour|time/i);
  });
});
