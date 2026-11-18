/**
 * The schedule pickers, driven through real antd panel cells (SCRUM-732).
 *
 * **The defect.** An empty antd `TimePicker` opens on midnight, so a pick that
 * touched only the hour column came out AM: a 9:00 AM start followed by a
 * click on "5" for the end stored 9:00 AM to 5:00 AM. The input did say
 * "5:00 AM", in small type, and nothing else did.
 *
 * **What is pinned here.** Where an empty panel opens, what an hour-only pick
 * becomes, that an explicit AM or PM is kept, that the shift is stated in words
 * beside the pickers, and that an existing value is shown and kept exactly as
 * stored. Then the full write/read cycle - pick, send, store as `TIME(0)`,
 * read back, show - on winter, summer and both DST transition days.
 *
 * **Which zones this proves.** The browser's zone is this process's zone, and
 * V8 fixes that per worker (`docs/testing.md`), so one run proves one zone. CI
 * runs the suite in UTC, `America/New_York` and `Asia/Kolkata`; the
 * expectations below are constants, so every leg must produce the same stored
 * values, which is the timezone-independence property itself. The
 * spring-forward 2:00 AM case can only fail in a zone that springs forward on
 * that date, which is the `America/New_York` leg.
 */

import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { useForm, UseFormReturn } from "react-hook-form";
import SelectTimeRange from "./SelectTimeRange";
import type { OnboardingFormInputs } from "../../utils/types";
import {
  formatScheduleTime,
  fromScheduleTimeInput,
  toScheduleTimeInput,
} from "../../utils/scheduleTime";
import {
  clickTimeCell,
  closeTimePicker,
  highlightedCells,
  installResizeObserverStub,
  openTimePicker,
  pickTime,
} from "../../testing/timePickerDriver";

installResizeObserverStub();

/** Exactly what Prisma hands back for a `@db.Time(0)` column. */
const storedAt = (utcHour: number, utcMinute = 0): Date =>
  new Date(Date.UTC(1970, 0, 1, utcHour, utcMinute));

let form: UseFormReturn<OnboardingFormInputs>;
/** Re-renders the harness, and so both pickers, with nothing changed. */
let renderAgain: () => void;

const Harness = ({
  startTime,
  endTime,
}: {
  startTime?: Date;
  endTime?: Date;
}) => {
  const f = useForm<OnboardingFormInputs>({
    defaultValues: { startTime, endTime },
  });
  const [, setRenders] = useState(0);
  form = f;
  renderAgain = () => setRenders((count) => count + 1);

  return <SelectTimeRange control={f.control} />;
};

const startInput = () => screen.getByLabelText(/Start Time/);
const endInput = () => screen.getByLabelText(/End Time/);

/**
 * The server side of a save and the next load, without a database: the ISO
 * string `updateUser` sends, the `Date` `user.edit` parses it into, the UTC
 * time of day a `TIME(0)` column keeps, and the epoch-dated `Date` Prisma reads
 * it back as.
 */
const throughTheDatabase = (picked: Date | null | undefined): Date => {
  const sent = toScheduleTimeInput(picked);
  const parsed = fromScheduleTimeInput(sent)!;

  return storedAt(parsed.getUTCHours(), parsed.getUTCMinutes());
};

describe("an empty schedule", () => {
  it("stays empty when a picker is opened and closed without a pick", async () => {
    render(<Harness />);

    await openTimePicker(endInput());
    await closeTimePicker(endInput());

    expect(endInput()).toHaveValue("");
    expect(form.getValues("endTime")).toBeUndefined();
  });

  it("opens the start panel on 9:00 AM rather than midnight", async () => {
    render(<Harness />);

    await openTimePicker(startInput());

    expect(highlightedCells()).toEqual(["09", "00", "AM"]);
  });

  it("opens the end panel eight hours after the start", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "09" });

    await openTimePicker(endInput());

    expect(highlightedCells()).toEqual(["05", "00", "PM"]);
  });

  it("turns an hour-only start pick into the morning", async () => {
    render(<Harness />);

    await pickTime(startInput(), { hour: "09" });

    expect(startInput()).toHaveValue("9:00 AM");
    expect(form.getValues("startTime")).toEqual(storedAt(14));
  });

  it("turns an hour-only end pick of 5 after a 9:00 AM start into 5:00 PM, not 5:00 AM", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "09" });

    await pickTime(endInput(), { hour: "05" });

    expect(endInput()).toHaveValue("5:00 PM");
    expect(form.getValues("endTime")).toEqual(storedAt(22));
  });

  it("turns an hour-only end pick of 4 after an 8:00 AM start into 4:00 PM", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "08" });

    await pickTime(endInput(), { hour: "04" });

    expect(endInput()).toHaveValue("4:00 PM");
    expect(
      screen.getByText("Your shift: 8:00 AM to 4:00 PM (8 hours)"),
    ).toBeInTheDocument();
  });

  it("serves a night shift: an hour-only end pick after a 10:00 PM start is the next morning", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "10", meridiem: "PM" });

    await pickTime(endInput(), { hour: "06" });

    expect(endInput()).toHaveValue("6:00 AM");
    expect(
      screen.getByText(
        "Your shift: 10:00 PM to 6:00 AM the next day (8 hours)",
      ),
    ).toBeInTheDocument();
  });

  it("keeps an explicit AM end, and says the shift then ends the next day", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "09" });

    await pickTime(endInput(), { hour: "05", meridiem: "AM" });

    expect(endInput()).toHaveValue("5:00 AM");
    expect(form.getValues("endTime")).toEqual(storedAt(10));
    expect(
      screen.getByText(
        "Your shift: 9:00 AM to 5:00 AM the next day (20 hours)",
      ),
    ).toBeInTheDocument();
  });

  it("keeps an explicit PM start, and an evening shift stays the same day", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "08", meridiem: "PM" });

    await pickTime(endInput(), { hour: "11", meridiem: "PM" });

    expect(startInput()).toHaveValue("8:00 PM");
    expect(endInput()).toHaveValue("11:00 PM");
    expect(
      screen.getByText("Your shift: 8:00 PM to 11:00 PM (3 hours)"),
    ).toBeInTheDocument();
  });

  it("keeps a pick in progress through a parent render", async () => {
    // The seed is rebuilt on every render. If antd re-read it while the panel
    // is open, the hour picked so far would be thrown away.
    render(<Harness />);
    await pickTime(startInput(), { hour: "09" });

    await openTimePicker(endInput());
    await clickTimeCell("hour", "05");
    await act(async () => renderAgain());
    await clickTimeCell("minute", "30");
    await closeTimePicker(endInput());

    expect(endInput()).toHaveValue("5:30 PM");
    expect(form.getValues("endTime")).toEqual(storedAt(22, 30));
  });

  it("says nothing about the shift until both ends are picked", async () => {
    render(<Harness />);
    await pickTime(startInput(), { hour: "09" });

    expect(screen.queryByText(/\(\d+ hours?\)/)).not.toBeInTheDocument();
  });
});

describe("an existing schedule", () => {
  it("shows the stored times as Boston wall clock, with AM and PM", () => {
    render(<Harness startTime={storedAt(14)} endTime={storedAt(22)} />);

    expect(startInput()).toHaveValue("9:00 AM");
    expect(endInput()).toHaveValue("5:00 PM");
    expect(
      screen.getByText("Your shift: 9:00 AM to 5:00 PM (8 hours)"),
    ).toBeInTheDocument();
  });

  it("is not rewritten by opening and closing a picker", async () => {
    const startTime = storedAt(14);
    const endTime = storedAt(22);
    render(<Harness startTime={startTime} endTime={endTime} />);

    await openTimePicker(endInput());
    await closeTimePicker(endInput());

    // Equal rather than identical: react-hook-form clones a `Date` default, so
    // the form never held these objects to begin with.
    expect(form.getValues("startTime")).toEqual(startTime);
    expect(form.getValues("endTime")).toEqual(endTime);
  });

  it("opens an existing value on that value, not on the seed", async () => {
    render(<Harness startTime={storedAt(14)} endTime={storedAt(10)} />);

    await openTimePicker(endInput());

    expect(highlightedCells()).toEqual(["05", "00", "AM"]);
  });

  it("stores the identical value when the stored hour is picked again", async () => {
    render(<Harness startTime={storedAt(14)} endTime={storedAt(22)} />);

    await pickTime(endInput(), { hour: "05" });

    expect(form.getValues("endTime")).toEqual(storedAt(22));
  });

  it("shows a legacy value that reads as overnight exactly as stored", () => {
    // 02:00-10:00 UTC, which today's display reads as 9:00 PM-5:00 AM.
    render(<Harness startTime={storedAt(2)} endTime={storedAt(10)} />);

    expect(startInput()).toHaveValue("9:00 PM");
    expect(endInput()).toHaveValue("5:00 AM");
    expect(
      screen.getByText("Your shift: 9:00 PM to 5:00 AM the next day (8 hours)"),
    ).toBeInTheDocument();
  });
});

/**
 * Freezes `Date` only. The picker's own timers stay real, because the driver
 * waits on them.
 */
const freezeDateAt = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "setImmediate",
      "clearImmediate",
      "nextTick",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "performance",
      "hrtime",
    ],
  });

describe.each([
  ["a winter day", "2026-01-15T15:00:00Z"],
  ["a summer day", "2026-07-15T15:00:00Z"],
  ["the day before spring-forward", "2026-03-07T15:00:00Z"],
  ["spring-forward day", "2026-03-08T15:00:00Z"],
  ["fall-back day", "2026-11-01T15:00:00Z"],
])("a fresh schedule picked on %s", (_label, now) => {
  beforeEach(() => {
    freezeDateAt(now);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    // [hour cell, meridiem cell, shown, stored UTC hour]
    ["09", undefined, "9:00 AM", 14],
    // 2:00 AM does not exist on spring-forward day in a US zone. A fresh pick
    // built on today's date there came out 3:00 AM.
    ["02", undefined, "2:00 AM", 7],
    // 1:00 AM happens twice on fall-back day in a US zone.
    ["01", undefined, "1:00 AM", 6],
    ["05", "PM", "5:00 PM", 22],
  ] as const)(
    "a %s %s start is shown, stored, and read back unchanged",
    async (hour, meridiem, shown, utcHour) => {
      const { unmount } = render(<Harness />);

      await pickTime(startInput(), { hour, meridiem });

      expect(startInput()).toHaveValue(shown);
      expect(form.getValues("startTime")).toEqual(storedAt(utcHour));

      const stored = throughTheDatabase(form.getValues("startTime"));
      expect(stored).toEqual(storedAt(utcHour));
      unmount();

      // Reopening the profile: the stored value as the picker and the
      // display show it.
      render(<Harness startTime={stored} />);
      expect(startInput()).toHaveValue(shown);
      expect(formatScheduleTime(stored)).toBe(shown);
    },
  );

  it("saves and reopens 9:00 AM to 5:00 PM as exactly that", async () => {
    const { unmount } = render(<Harness />);
    await pickTime(startInput(), { hour: "09" });
    await pickTime(endInput(), { hour: "05" });

    const startTime = throughTheDatabase(form.getValues("startTime"));
    const endTime = throughTheDatabase(form.getValues("endTime"));
    unmount();
    render(<Harness startTime={startTime} endTime={endTime} />);

    expect(startTime).toEqual(storedAt(14));
    expect(endTime).toEqual(storedAt(22));
    expect(startInput()).toHaveValue("9:00 AM");
    expect(endInput()).toHaveValue("5:00 PM");
  });
});
