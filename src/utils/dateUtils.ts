import React from "react";
import { UseFormSetValue } from "react-hook-form";
import { OnboardingFormInputs } from "./types";

/**
 * Last day of the month named by a `<input type="month">` value ("2024-03"),
 * at midnight UTC.
 *
 * `coopStartDate`/`coopEndDate` are `@db.Date` columns, and Prisma takes the
 * UTC date out of whatever `Date` it is given. Building the day in local time
 * with `new Date(year, month, 0)` therefore stored the day before whenever the
 * user sat at a positive UTC offset: picking March in Berlin produced midnight
 * local, which is 23:00 UTC on 30 March, so the column recorded the 30th
 * (SCRUM-239).
 *
 * Constructing the day in UTC makes the stored date the same everywhere.
 */
const lastDayOfMonthUTC = (monthValue: string): Date | null => {
  const [year, month] = monthValue.split("-").map(Number);

  if (!year || !month) {
    return null;
  }

  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0));
};

const handleMonthChange =
  (
    field: "coopStartDate" | "coopEndDate",
    setValue: UseFormSetValue<OnboardingFormInputs>,
  ) =>
  (event: React.ChangeEvent<HTMLInputElement>): void => {
    const lastDay = lastDayOfMonthUTC(event.target.value);

    if (!lastDay) {
      return;
    }

    setValue(field, lastDay, { shouldValidate: true });
  };

/**
 * Renders a stored co-op date back into the "YYYY-MM" an `<input type="month">`
 * expects. Read in UTC to match how `lastDayOfMonthUTC` writes it, so the month
 * shown is the month chosen regardless of where the reader is.
 */
const formatDateToMonth = (date: Date | null): string | undefined => {
  if (!date) {
    return undefined;
  }
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

export { handleMonthChange, formatDateToMonth, lastDayOfMonthUTC };
