import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Filters from "./Filters";
import { FiltersState } from "../../utils/types";

/**
 * The Explore filter panel.
 *
 * The defect these exist for is a **display-versus-state split**: the
 * flex-days input's `value` was
 * `flexDays > selectedDaysCount ? selectedDaysCount : flexDays`, a clamp that
 * never reached state. With no days selected the box showed `0` — which would
 * match everyone — while `1` was what got sent and scored, and `1` against
 * zero shared days rejected every candidate. So the control displayed the
 * reason it was returning nothing and displayed it wrongly.
 *
 * `Filters` is renderable here because it takes its state as props and touches
 * no router, no tRPC client and no map. The harness below holds that state for
 * real, which is the point: an assertion against a `filters` prop the test
 * itself pins would pass with the display clamp still in place.
 */

const BASE: FiltersState = {
  days: 0,
  flexDays: 1,
  startDistance: 20,
  endDistance: 20,
  daysWorking: "",
  startTime: 4,
  endTime: 4,
  startDate: new Date("2026-01-31T00:00:00.000Z"),
  endDate: new Date("2026-06-30T00:00:00.000Z"),
  dateOverlap: 0,
  favorites: false,
  messaged: false,
};

/**
 * Renders `Filters` against real `useState`, and mirrors the two fields under
 * test into the DOM so a test can compare what is *shown* with what is
 * *stored* rather than trusting either alone.
 */
const Harness = ({
  initial,
  // Sections start collapsed unless a filter in them is active, so a test has
  // to say which one it needs open. Days Match by default.
  activeFilters = { days: true },
}: {
  initial?: Partial<FiltersState>;
  activeFilters?: { [key: string]: boolean };
}) => {
  const [filters, setFilters] = useState<FiltersState>({
    ...BASE,
    ...initial,
  });

  return (
    <>
      <Filters
        onClose={() => undefined}
        filters={filters}
        setFilters={setFilters}
        activeFilters={activeFilters}
        resetFilters={() => undefined}
      />
      <output data-testid="state-flex-days">{filters.flexDays}</output>
      <output data-testid="state-days-working">{filters.daysWorking}</output>
    </>
  );
};

const flexDaysInput = () => screen.getByTestId("flex-days") as HTMLInputElement;
const shownFlexDays = () => flexDaysInput().value;
const storedFlexDays = () => screen.getByTestId("state-flex-days").textContent;

describe("Filters — the flex-days control", () => {
  it("shows the value in state when no days are selected", () => {
    // The defect, exactly: `0` was displayed while `1` was enforced.
    render(<Harness initial={{ days: 2, flexDays: 1, daysWorking: "" }} />);

    expect(shownFlexDays()).toBe("1");
    expect(shownFlexDays()).toBe(storedFlexDays());
  });

  it("never offers a range no value can satisfy", () => {
    // `max` was `selectedDaysCount`, so with nothing selected the input read
    // min=1 max=0.
    render(<Harness initial={{ days: 2, daysWorking: "" }} />);

    const max = Number(flexDaysInput().max);
    const min = Number(flexDaysInput().min);

    expect(max).toBeGreaterThanOrEqual(min);
  });

  it("shows the value in state when it exceeds the days selected", () => {
    // Reachable through a `resetFilters` or a seeded `daysWorking`, and the
    // case the old clamp was written for — it hid the mismatch instead of
    // resolving it.
    render(
      <Harness
        initial={{ days: 2, flexDays: 5, daysWorking: "0,1,1,0,0,0,0" }}
      />,
    );

    expect(shownFlexDays()).toBe(storedFlexDays());
  });

  it("clamps into state when a day is unchecked, keeping shown and stored equal", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ days: 2, flexDays: 3, daysWorking: "0,1,1,1,0,0,0" }}
      />,
    );

    expect(shownFlexDays()).toBe("3");

    // Uncheck Wednesday, leaving two selected days. `flexDays` of 3 is no
    // longer satisfiable, so state itself has to come down - not just the
    // rendered value.
    await user.click(screen.getAllByRole("checkbox")[3]);

    expect(screen.getByTestId("state-days-working").textContent).toBe(
      "0,1,1,0,0,0,0",
    );
    expect(storedFlexDays()).toBe("2");
    expect(shownFlexDays()).toBe("2");
  });

  it("writes a replaced value into state", async () => {
    // Selecting the contents and typing over them, which is how a number this
    // small actually gets changed. Typing *after* a `clear` is a different
    // journey and is covered below.
    //
    // `tripleClick` rather than `type("{selectall}4")`: userEvent 14 does not
    // treat `{selectall}` as a command inside `type`, so that form appends and
    // this test would have asserted 4 against an actual 5.
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ days: 2, flexDays: 1, daysWorking: "0,1,1,1,1,1,0" }}
      />,
    );

    await user.tripleClick(flexDaysInput());
    await user.keyboard("4");

    expect(storedFlexDays()).toBe("4");
    expect(shownFlexDays()).toBe("4");
  });

  it("holds a typed value above the days selected down to the cap", () => {
    // `fireEvent` rather than `userEvent`, because typing "9" one key at a
    // time is a different journey than the browser's own clamping of a
    // pasted value.
    render(
      <Harness
        initial={{ days: 2, flexDays: 1, daysWorking: "0,1,1,0,0,0,0" }}
      />,
    );

    fireEvent.change(flexDaysInput(), { target: { value: "9" } });

    expect(storedFlexDays()).toBe("2");
    expect(shownFlexDays()).toBe("2");
  });

  it("snaps to the minimum when the box is cleared, rather than stranding state", async () => {
    // The old `!isNaN` guard skipped the update entirely, leaving state
    // holding a value the emptied box no longer showed — the same
    // display-versus-state split, reached a different way.
    //
    // Snapping to `min` is the deliberate choice over letting the field sit
    // empty: an empty intermediate value would need a second piece of string
    // state to hold it, and this input is a spinner between 1 and 7 where
    // clamping an invalid entry to the bound is ordinary behaviour. The
    // consequence is that clearing and then typing appends to the `1`, which
    // is why the test above selects rather than clears.
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ days: 2, flexDays: 4, daysWorking: "0,1,1,1,1,1,0" }}
      />,
    );

    await user.clear(flexDaysInput());

    expect(storedFlexDays()).toBe("1");
    expect(shownFlexDays()).toBe(storedFlexDays());
  });
});

describe("Filters — the inert day filter", () => {
  it.each([
    { days: 1, mode: "Exact" },
    { days: 2, mode: "Flex" },
  ])("says the $mode filter is not narrowing anything yet", ({ days }) => {
    // Both halves of the ticket's items (1) and (3). The mode buttons cannot
    // be disabled until a day is checked - the day checkboxes only render
    // *after* a mode is chosen, so that would deadlock the panel - so the
    // panel explains the state instead.
    render(<Harness initial={{ days, daysWorking: "" }} />);

    expect(screen.getByTestId("day-filter-inert")).toBeInTheDocument();
  });

  it("drops the notice once a day is selected", () => {
    render(<Harness initial={{ days: 2, daysWorking: "0,1,0,0,0,0,0" }} />);

    expect(screen.queryByTestId("day-filter-inert")).not.toBeInTheDocument();
  });

  it("drops the notice as soon as the user checks a day", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ days: 1, daysWorking: "" }} />);

    expect(screen.getByTestId("day-filter-inert")).toBeInTheDocument();

    await user.click(screen.getAllByRole("checkbox")[1]);

    expect(screen.queryByTestId("day-filter-inert")).not.toBeInTheDocument();
  });

  it("shows no notice in Any mode, which is honestly unfiltered", () => {
    render(<Harness initial={{ days: 0, daysWorking: "" }} />);

    expect(screen.queryByTestId("day-filter-inert")).not.toBeInTheDocument();
  });

  it("replaces the Exact-days help text rather than stacking with it", () => {
    render(<Harness initial={{ days: 1, daysWorking: "" }} />);

    expect(screen.queryByText(/Exact days only shows users/)).toBeNull();
  });
});

describe("Filters — the day checkboxes", () => {
  it("keeps every checkbox controlled when no days are selected", async () => {
    // Not in the ticket; found by this suite. `checked` was
    // `daysWorking.split(",").map(...)[index]`, and `"".split(",")` is `[""]` —
    // so six of the seven boxes got `checked={undefined}` and were
    // uncontrolled, in the state the map starts in and a VIEWER never leaves.
    // React and MUI each logged a switch-to-controlled error on the first
    // toggle. Asserting on `console.error` is the only way that surfaces,
    // since `lint --max-warnings=0` cannot see a runtime warning.
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      render(<Harness initial={{ days: 1, daysWorking: "" }} />);

      await user.click(screen.getAllByRole("checkbox")[3]);

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("writes a well-formed seven-field string from an empty one", async () => {
    // It used to write `"0,,,1"`.
    const user = userEvent.setup();
    render(<Harness initial={{ days: 1, daysWorking: "" }} />);

    await user.click(screen.getAllByRole("checkbox")[3]);

    expect(screen.getByTestId("state-days-working").textContent).toBe(
      "0,0,0,1,0,0,0",
    );
  });

  it("reflects the stored selection in the boxes", () => {
    render(<Harness initial={{ days: 1, daysWorking: "0,1,0,1,0,0,0" }} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];

    expect(boxes.map((box) => box.checked)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("Filters — control labels", () => {
  it("labels the start-time deviation as a maximum", () => {
    // `calculateScore` rejects when the deviation *exceeds* this value. The
    // label said "Min", which inverts the control: a user wanting a tight
    // schedule match would drag it the wrong way.
    render(<Harness initial={{}} activeFilters={{ startTime: true }} />);

    expect(
      screen.getByText("Max deviation in start time (hours)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Min deviation in start time/)).toBeNull();
  });

  it("labels both time controls the same way", () => {
    render(<Harness initial={{}} activeFilters={{ startTime: true }} />);

    expect(
      screen.getByText("Max deviation in end time (hours)"),
    ).toBeInTheDocument();
  });
});
