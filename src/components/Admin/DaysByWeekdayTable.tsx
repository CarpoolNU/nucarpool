import React from "react";
import { UNSPECIFIED_DAYS_LABEL } from "../../utils/adminDashboardLabels";
import { AdminDaysByWeekday } from "../../utils/types";

interface DaysByWeekdayTableProps {
  daysByWeekday: AdminDaysByWeekday;
}

/**
 * The chart's numbers as text: exact counts per weekday, and which days have
 * riders and no driver. A chart gives the shape; the table is what an admin
 * reads the figure off, and what a screen reader is given.
 *
 * A stranded day is marked in words, not only by colour. The `Unspecified` row
 * is a head count of people who named no day, not a day, so it is set apart
 * and carries no status.
 */
function DaysByWeekdayTable({ daysByWeekday }: DaysByWeekdayTableProps) {
  const { days, unspecified } = daysByWeekday;

  if (
    unspecified.drivers + unspecified.riders === 0 &&
    days.every((row) => row.drivers === 0 && row.riders === 0)
  ) {
    return null;
  }

  return (
    <div className="w-full shrink-0 overflow-x-auto">
      <table className="font-lato w-full text-left text-sm">
        <caption className="font-montserrat pb-2 text-left text-lg font-bold">
          Availability by Day of the Week
        </caption>
        <thead>
          <tr className="border-b border-gray-300">
            <th scope="col" className="py-2 pr-4">
              Day
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Drivers
            </th>
            <th scope="col" className="py-2 pr-4 text-right">
              Riders
            </th>
            <th scope="col" className="py-2">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map((row) => (
            <tr key={row.day} className="border-b border-gray-100">
              <th scope="row" className="py-2 pr-4 font-normal">
                {row.day}
              </th>
              <td className="py-2 pr-4 text-right">{row.drivers}</td>
              <td className="py-2 pr-4 text-right">{row.riders}</td>
              <td className="py-2">
                {row.stranded ? (
                  <span className="rounded bg-red-100 px-2 py-0.5 font-bold text-red-800">
                    No driver
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
          <tr className="border-b border-gray-100">
            <th scope="row" className="py-2 pr-4 font-normal">
              {UNSPECIFIED_DAYS_LABEL}
            </th>
            <td className="py-2 pr-4 text-right">{unspecified.drivers}</td>
            <td className="py-2 pr-4 text-right">{unspecified.riders}</td>
            <td className="py-2" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default DaysByWeekdayTable;
