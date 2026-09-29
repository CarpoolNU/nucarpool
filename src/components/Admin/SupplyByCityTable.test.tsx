import { render, screen, within } from "@testing-library/react";
import SupplyByCityTable from "./SupplyByCityTable";
import type { AdminSupplyRow } from "../../utils/types";

/**
 * The supply table: the chart's numbers as text, and the one row an admin
 * most needs to see picked out. Real DOM, no stub - there is no canvas here.
 */

const boston: AdminSupplyRow = {
  city: "Boston",
  kind: "city",
  drivers: 3,
  riders: 7,
  openSeats: 5,
  ridersPerDriver: 2.3,
  stranded: false,
};

const worcester: AdminSupplyRow = {
  city: "Worcester",
  kind: "city",
  drivers: 0,
  riders: 2,
  openSeats: 0,
  ridersPerDriver: null,
  stranded: true,
};

const rowFor = (city: string) =>
  screen.getByRole("row", { name: new RegExp(city) });

describe("SupplyByCityTable", () => {
  it("has a header cell for every column, so a reader is told what each number is", () => {
    render(<SupplyByCityTable supplyByCity={[boston]} />);

    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual([
      "City",
      "Drivers",
      "Riders",
      "Open seats",
      "Riders per driver",
      "Status",
    ]);
  });

  it("writes each city's counts and ratio on its own row", () => {
    render(<SupplyByCityTable supplyByCity={[boston, worcester]} />);

    expect(
      within(rowFor("Boston"))
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["3", "7", "5", "2.3", ""]);
  });

  it("marks a city with riders and no driver in words", () => {
    render(<SupplyByCityTable supplyByCity={[boston, worcester]} />);

    expect(within(rowFor("Worcester")).getByText("No driver")).toBeVisible();
    expect(within(rowFor("Boston")).queryByText("No driver")).toBeNull();
  });

  it("shows a dash, and no Infinity or NaN, where there is no driver to divide by", () => {
    const { container } = render(
      <SupplyByCityTable supplyByCity={[worcester]} />,
    );

    expect(within(rowFor("Worcester")).getByText("—")).toBeVisible();
    expect(container.textContent).not.toMatch(/Infinity|NaN|null/);
  });

  it("shows a real zero ratio as 0, not as missing", () => {
    render(
      <SupplyByCityTable
        supplyByCity={[{ ...boston, riders: 0, ridersPerDriver: 0 }]}
      />,
    );

    expect(
      within(rowFor("Boston"))
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["3", "0", "5", "0", ""]);
  });

  it("renders nothing when there are no rows, since the chart already says so", () => {
    const { container } = render(<SupplyByCityTable supplyByCity={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("renders a city name as text, whatever it contains", () => {
    const { container } = render(
      <SupplyByCityTable
        supplyByCity={[{ ...boston, city: "<img src=x onerror=alert(1)>" }]}
      />,
    );

    // React escapes it; an element here would mean something wrote HTML.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
  });
});
