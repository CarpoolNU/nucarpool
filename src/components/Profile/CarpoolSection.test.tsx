import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import CarpoolSection from "./CarpoolSection";
import { OnboardingFormInputs } from "../../utils/types";
import { useAddressSelection } from "../../utils/useAddressSelection";

/**
 * SCRUM-513. `EntryLabel` had no `htmlFor`, and `ControlledAddressCombobox`
 * had no `id` on its underlying input at all, so "Home Address" and
 * "Workplace Address" announced as unlabelled despite the visible text above
 * each combobox.
 */
const addressHook = (): ReturnType<typeof useAddressSelection> => ({
  selectedAddress: { place_name: "", center: [0, 0] },
  setSelectedAddress: jest.fn(),
  // `updateAddress` is a lodash `debounce`d setter, which carries `cancel`
  // and `flush` alongside the call signature `ControlledAddressCombobox`
  // actually uses.
  updateAddress: Object.assign(jest.fn(), {
    cancel: jest.fn(),
    flush: jest.fn(),
  }),
  suggestions: [],
});

const Harness = () => {
  const { register, watch, setValue, control, handleSubmit, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: {
        role: Role.DRIVER,
        status: Status.ACTIVE,
        companyName: "",
      },
    });

  return (
    <CarpoolSection
      register={register}
      watch={watch}
      setValue={setValue}
      control={control}
      errors={formState.errors}
      onSubmit={handleSubmit(() => undefined)}
      startAddressHook={addressHook()}
      companyAddressHook={addressHook()}
    />
  );
};

describe("CarpoolSection accessible names", () => {
  it("names the address and workplace fields after their visible labels", () => {
    render(<Harness />);

    // The asterisk is inside each `<label>` for a non-viewer role, so it is
    // part of the computed accessible name. Headless UI's `Combobox.Input`
    // carries `role="combobox"`, not `textbox`.
    expect(
      screen.getByRole("combobox", { name: "Home Address *" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Workplace Name *" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Workplace Address *" }),
    ).toBeInTheDocument();
  });
});
