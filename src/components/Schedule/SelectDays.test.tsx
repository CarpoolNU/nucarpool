import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import SelectDays from "./SelectDays";
import { OnboardingFormInputs } from "../../utils/types";

/**
 * SCRUM-513. The seven day boxes put their letter inside the MUI `Checkbox`'s
 * `icon`/`checkedIcon`, which is not a name source for an `<input>` - so all
 * seven announced as identical, unnamed checkboxes. `slotProps={{ input: {
 * "aria-label": day } }}` is the fix.
 *
 * The count assertion runs first and separately from the name assertions:
 * without it, a change that stopped rendering the checkboxes entirely would
 * still pass a loop of `getByRole("checkbox", { name: day })` calls that never
 * ran, or would fail with a misleading "not found" instead of the real
 * "wrong count" defect.
 */
const Harness = () => {
  const { control } = useForm<OnboardingFormInputs>({
    defaultValues: { daysWorking: new Array(7).fill(false) },
  });

  return <SelectDays control={control} />;
};

describe("SelectDays accessible names", () => {
  it("renders exactly seven checkboxes", () => {
    render(<Harness />);

    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
  });

  it("gives each day checkbox its own distinct accessible name", () => {
    render(<Harness />);

    for (const day of ["Su", "M", "Tu", "W", "Th", "F", "S"]) {
      expect(screen.getByRole("checkbox", { name: day })).toBeInTheDocument();
    }
  });
});
