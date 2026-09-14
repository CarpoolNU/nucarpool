import { render } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import AccountSection from "./AccountSection";
import { OnboardingFormInputs } from "../../utils/types";

/**
 * The two co-op month pickers, and the one prop that decides whether tapping
 * one is usable on a phone.
 *
 * antd's `DatePicker` renders a real `<input>`. Left focusable, a tap on a
 * touch device opens the soft keyboard *and* the month panel, and the keyboard
 * covers the panel it just opened - so the control is materially harder to use
 * than the identical pickers in `Setup/StepThree`, which pass
 * `inputReadOnly`. Nothing is typed into these fields; a month is only ever
 * chosen from the panel.
 *
 * **`readOnly` is the assertion, not the keyboard.** jsdom has no soft
 * keyboard and no touch, so "no keyboard appears" is not observable here -
 * what is observable is that the input is not a typing target, which is the
 * property the platform keys its behaviour off. Confirming the keyboard stays
 * down needs a real device.
 */

/**
 * `AccountSection` takes react-hook-form's `control`, `watch`, `setValue` and
 * `errors` as props rather than reading a context, so a real `useForm` is the
 * cheapest honest harness - mocking the shape would assert against the mock.
 *
 * `role` has to be a non-`VIEWER` value: the pickers are rendered `disabled`
 * for a viewer, and a disabled antd input is read-only for an unrelated
 * reason, which would make the test pass with the fix reverted.
 */
const Harness = () => {
  const { control, watch, setValue, handleSubmit, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: {
        role: Role.DRIVER,
        status: Status.ACTIVE,
        coopStartDate: new Date("2026-01-15T00:00:00Z"),
        coopEndDate: new Date("2026-06-15T00:00:00Z"),
      },
    });

  return (
    <AccountSection
      control={control}
      watch={watch}
      setValue={setValue}
      errors={formState.errors}
      onSubmit={handleSubmit(() => undefined)}
    />
  );
};

describe("AccountSection co-op date pickers", () => {
  it.each([
    ["start", "coopStartDate"],
    ["end", "coopEndDate"],
  ])("renders the %s date picker read-only", (_label, id) => {
    const { container } = render(<Harness />);

    const input = container.querySelector<HTMLInputElement>(`input#${id}`);

    expect(input).not.toBeNull();
    // Asserted on the property as well as the attribute: antd sets
    // `readOnly` through React, and the two can disagree if it is ever passed
    // as a string.
    expect(input).toHaveAttribute("readonly");
    expect(input?.readOnly).toBe(true);
    // The picker must still be reachable - `inputReadOnly` must not have been
    // confused with `disabled`, which would stop the panel opening at all.
    expect(input?.disabled).toBe(false);
  });
});
