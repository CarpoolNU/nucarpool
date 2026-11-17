import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import ControlledTimePicker from "./ControlledTimePicker";
import { formatScheduleTime } from "../../utils/scheduleTime";
import type { OnboardingFormInputs } from "../../utils/types";

/**
 * How the values `scripts/repair-dst-schedule-times.ts` writes are shown.
 *
 * The repair moves a schedule stored at the EDT offset forward one hour onto
 * the EST anchor that `SCHEDULE_ANCHOR_DATE` defines. Its whole visible effect
 * depends on two read paths agreeing with that anchor: `formatScheduleTime`,
 * which renders other users' schedules on the Explore card and in the Connect
 * modal, and `ControlledTimePicker`, which shows the owner their own schedule
 * on the profile page.
 *
 * The property most worth pinning is that the display does **not** depend on
 * the date the page is viewed. The repaired rows were authored under EDT and
 * are read all year. A read path that resolved Boston's offset at "now"
 * instead of at the anchor would be right in winter and an hour out all
 * summer, so it would quietly undo the repair for half the year.
 * `scheduleTime.test.ts` never moves the clock, so it cannot catch that.
 *
 * The stored values are synthetic. They are the repair's three output shapes,
 * reduced to the four distinct times of day they use, and identify no row.
 */

/** Prisma hands a MySQL `TIME(0)` back as an epoch-dated UTC `Date`. */
const storedAt = (hhmm: string): Date => new Date(`1970-01-01T${hhmm}:00.000Z`);

/** Each time of day the repair writes, and the Boston wall clock it means. */
const REPAIRED_VALUES: [stored: string, shown: string][] = [
  ["14:00", "9:00 AM"],
  ["22:00", "5:00 PM"],
  ["13:00", "8:00 AM"],
  ["21:00", "4:00 PM"],
];

describe("formatScheduleTime on the values the DST repair writes", () => {
  afterEach(() => jest.useRealTimers());

  it.each(REPAIRED_VALUES)("renders a stored %s as %s", (stored, shown) => {
    expect(formatScheduleTime(storedAt(stored))).toBe(shown);
  });

  it.each([
    ["in January (EST)", "2026-01-15T12:00:00Z"],
    ["in July (EDT)", "2026-07-15T12:00:00Z"],
    ["on the fall-back morning", "2026-11-01T06:30:00Z"],
    ["in November (EST)", "2026-11-17T12:00:00Z"],
  ])("renders the same wall clock when viewed %s", (_season, now) => {
    jest.useFakeTimers({ now: new Date(now) });
    for (const [stored, shown] of REPAIRED_VALUES) {
      expect(formatScheduleTime(storedAt(stored))).toBe(shown);
    }
  });

  it("shows each repaired value exactly one hour after the value it replaced", () => {
    const shifts: [before: string, after: string, was: string, now: string][] =
      [
        ["13:00", "14:00", "8:00 AM", "9:00 AM"],
        ["21:00", "22:00", "4:00 PM", "5:00 PM"],
        ["12:00", "13:00", "7:00 AM", "8:00 AM"],
        ["20:00", "21:00", "3:00 PM", "4:00 PM"],
      ];
    for (const [before, after, was, now] of shifts) {
      expect(formatScheduleTime(storedAt(before))).toBe(was);
      expect(formatScheduleTime(storedAt(after))).toBe(now);
    }
  });
});

describe("ControlledTimePicker on the values the DST repair writes", () => {
  /** The owner's profile form, loaded with a stored schedule time. */
  const Harness = ({ value }: { value: Date }) => {
    const { control } = useForm<OnboardingFormInputs>({
      defaultValues: { startTime: value },
    });
    return (
      <ControlledTimePicker control={control} name="startTime" id="start" />
    );
  };

  it.each(REPAIRED_VALUES)("shows a stored %s as %s", (stored, shown) => {
    render(<Harness value={storedAt(stored)} />);
    expect(screen.getByRole("textbox")).toHaveValue(shown);
  });
});
