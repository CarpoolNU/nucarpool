import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import StepTwo from "./StepTwo";
import { OnboardingFormInputs } from "../../utils/types";
import { useAddressSelection } from "../../utils/useAddressSelection";

/**
 * SCRUM-513. `EntryLabel` had no `htmlFor`, and `ControlledAddressCombobox`
 * had no `id` on its underlying input at all, so "Start Address" and
 * "Workplace Address" announced as unlabelled despite the visible text above
 * each combobox.
 */
const addressHook = (): ReturnType<typeof useAddressSelection> => ({
  selectedAddress: { place_name: "", center: [0, 0] },
  setSelectedAddress: jest.fn(),
  // A lodash `debounce`d setter, which carries `cancel`/`flush` alongside the
  // call signature `ControlledAddressCombobox` actually uses.
  updateAddress: Object.assign(jest.fn(), {
    cancel: jest.fn(),
    flush: jest.fn(),
  }),
  suggestions: [],
});

const Harness = () => {
  const { register, control, formState } = useForm<OnboardingFormInputs>({
    defaultValues: { companyName: "" },
  });

  return (
    <StepTwo
      register={register}
      errors={formState.errors}
      control={control}
      startAddressHook={addressHook()}
      companyAddressHook={addressHook()}
    />
  );
};

describe("StepTwo accessible names", () => {
  it("names the address and workplace fields after their visible labels", () => {
    render(<Harness />);

    // The asterisk is inside each `<label>`, since every field on this step
    // is required. Headless UI's `Combobox.Input` carries `role="combobox"`,
    // not `textbox`.
    expect(
      screen.getByRole("combobox", { name: "Start Address *" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Workplace Name *" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Workplace Address *" }),
    ).toBeInTheDocument();
  });
});
