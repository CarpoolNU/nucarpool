import React from "react";
import { AdminSupplyRow } from "../../utils/types";

interface SupplyByCityTableProps {
  supplyByCity: AdminSupplyRow[];
}

/**
 * The chart's numbers as text: exact counts, riders per driver, and which
 * cities have riders and no driver. A chart gives the shape; the table is
 * what an admin reads the figure off, and what a screen reader is given.
 *
 * A stranded city is marked in words, not only by colour, and its ratio is a
 * dash: with no driver there is no number to show, and none is invented.
 */
function SupplyByCityTable({ supplyByCity }: SupplyByCityTableProps) {
  if (supplyByCity.length === 0) {
    return null;
  }

  return (
    <div className="w-full shrink-0 overflow-x-auto">
      <table className="font-lato w-full text-left text-sm">
        <caption className="font-montserrat pb-2 text-left text-lg font-bold">
          Supply by City
        </caption>
        <thead>
          <tr className="border-b border-gray-300">
            <th scope="col" className="py-2 pr-4">
              City
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Drivers
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Riders
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Open seats
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Riders per driver
            </th>
            <th scope="col" className="py-2">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {supplyByCity.map((row) => (
            <tr
              key={`${row.kind}-${row.city}`}
              className="border-b border-gray-100"
            >
              <th scope="row" className="py-2 pr-4 font-normal">
                {row.city}
              </th>
              <td className="py-2 pr-4 text-right">{row.drivers}</td>
              <td className="py-2 pr-4 text-right">{row.riders}</td>
              <td className="py-2 pr-4 text-right">{row.openSeats}</td>
              <td className="py-2 pr-4 text-right">
                {row.ridersPerDriver ?? "—"}
              </td>
              <td className="py-2">
                {row.stranded ? (
                  <span className="rounded bg-red-100 px-2 py-0.5 font-bold text-red-800">
                    No driver
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default SupplyByCityTable;
