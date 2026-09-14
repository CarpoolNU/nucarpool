import { ErrorDisplay, Note, ProfileHeader } from "../../styles/profile";
import { Role } from "@prisma/client";
import { EntryLabel } from "../EntryLabel";
import { TextField } from "../TextField";
import {
  Control,
  FieldError,
  FieldErrors,
  UseFormHandleSubmit,
  UseFormRegister,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { OnboardingFormInputs, User } from "../../utils/types";
import ControlledAddressCombobox from "./ControlledAddressCombobox";
import { PROFILE_TEXT_MAX_LENGTH } from "../../utils/textLimits";
import { useAddressSelection } from "../../utils/useAddressSelection";
import SelectDays from "../Schedule/SelectDays";
import SelectTimeRange from "../Schedule/SelectTimeRange";
interface CarpoolSectionProps {
  register: UseFormRegister<OnboardingFormInputs>;
  errors: FieldErrors<OnboardingFormInputs>;
  setValue: UseFormSetValue<OnboardingFormInputs>;
  watch: UseFormWatch<OnboardingFormInputs>;
  onFileSelect: (file: File | null) => void;
  control: Control<OnboardingFormInputs>;
  onSubmit: ReturnType<UseFormHandleSubmit<OnboardingFormInputs>>;
  startAddressHook: ReturnType<typeof useAddressSelection>;
  companyAddressHook: ReturnType<typeof useAddressSelection>;
  user?: User;
}
const CarpoolSection = ({
  errors,
  watch,
  register,
  onSubmit,
  control,
  startAddressHook,
  companyAddressHook,
  user,
}: CarpoolSectionProps) => {
  const isViewer = watch("role") === Role.VIEWER;

  return (
    <div className="flex flex-col space-y-4">
      {/*
        The mobile size is the base and desktop overrides it, which is the same
        24px/36px pair `UserSection` and `AccountSection` reach with an
        `isMobile` ternary - this tab was the only one of the three that never
        scaled down.

        `desktop:` rather than the hook, per the direction set for styling-only
        viewport differences: this is one number, not a different tree, and a
        hook renders its server snapshot once during hydration. `desktop:` is
        640px from the same `MOBILE_BREAKPOINT_PX` the hook reads, so the two
        cannot disagree about where mobile ends. Note `sm:` would be the trap
        here - this project overrides Tailwind's screens and `sm` is 576px.
      */}
      <ProfileHeader className={"desktop:!text-4xl !text-2xl"}>
        Carpool Details
      </ProfileHeader>

      <EntryLabel
        label="Commuting Schedule"
        required={true}
        error={errors.daysWorking as FieldError | (FieldError | undefined)[]}
        className={"!text-2xl"}
      />

      <div className="mb-2 w-full max-w-[360px] md:my-4 lg:pl-20">
        {/*
          Seven boxes at the base 40px plus 8px of `ml-2` each need 336px. The
          mobile profile content is inset `px-8`, so a 375px phone offers 311px
          and a 360px one 296px - the row overflowed both, and since the
          scroller above sets `overflow-y-auto` with the x-axis left visible,
          CSS computes that axis to `auto` and the whole tab panned sideways.
          Worse than the panning: the MUI `Checkbox` wrappers shrink to their
          share of the row while the box inside them does not, so each box
          overhung its own hit area and a tap could land on the neighbouring
          day or on nothing.

          32px puts the row at 7 x 40px = 280px, inside both widths, and back
          inside the ~44px each checkbox gets - so the target and the box the
          user is aiming at coincide again. The `ml-2` gap is kept rather than
          traded away, since shrinking the gap instead would leave the targets
          narrower still.

          **`max-desktop:` is doing specific work.** It compiles to
          `@media (width < 640px)`, which is disjoint from the `md:` (834px)
          and `lg:` (1440px) sizes `DayBox` carries, so the two can never both
          apply and the desktop ladder is untouched. An unconditional
          `!h-8 !w-8` - what `StepThree` passes, correctly, to a `StaticDayBox`
          that has no such ladder - would have overridden `md:h-14` and
          `lg:h-16` at every width and shrunk the desktop picker.

          This only does anything because `DayBox` now declares `className`;
          until it did, the prop was accepted, type-checked and dropped.
        */}
        <SelectDays
          control={control}
          disabled={isViewer}
          dayBoxClassName="max-desktop:!h-8 max-desktop:!w-8"
          error={errors.daysWorking}
        />
      </div>
      {errors.daysWorking && (
        <ErrorDisplay>{errors.daysWorking.message}</ErrorDisplay>
      )}
      <SelectTimeRange
        control={control}
        errors={{
          startTime: errors.startTime,
          endTime: errors.endTime,
        }}
        isDisabled={isViewer}
        noteText="Please input the start and end times of your work, rather than your departure times. If your work hours are flexible, coordinate directly with potential riders or drivers to inform them."
        noteClassName="py-4 md:w-96"
        containerClassName="relative mt-4 flex w-full justify-between gap-6 pb-4 md:w-96"
        timePickerValues={{
          startTime: user?.startTime ? user.startTime : undefined,
          endTime: user?.endTime ? user.endTime : undefined,
        }}
      />
      <EntryLabel label="Locations" className={"!text-2xl"} />
      <EntryLabel
        required={!isViewer}
        error={errors.startAddress}
        className={"my-2 !text-lg"}
        label="Home Address"
      />
      <div className="z-10">
        <ControlledAddressCombobox
          isDisabled={isViewer}
          control={control}
          name={"startAddress"}
          addressSelected={startAddressHook.selectedAddress}
          addressSetter={startAddressHook.setSelectedAddress}
          addressSuggestions={startAddressHook.suggestions}
          error={errors.startAddress}
          addressUpdater={startAddressHook.updateAddress}
        />

        <Note className="pt-2">
          Note: Your address will only be used to find users close to you. It
          will not be displayed to any other users.
        </Note>
      </div>
      {errors.startAddress && (
        <ErrorDisplay>{errors.startAddress.message}</ErrorDisplay>
      )}
      <EntryLabel
        required={!isViewer}
        error={errors.companyName}
        className={"my-2 !text-lg"}
        label="Workplace Name"
      />
      <TextField
        className={`w-full`}
        inputClassName={`h-12`}
        label="Workplace Name"
        isDisabled={isViewer}
        id="companyName"
        error={errors.companyName}
        type="text"
        // Matches `company_name`'s `VARCHAR(191)`.
        charLimit={PROFILE_TEXT_MAX_LENGTH}
        {...register("companyName")}
      />
      <EntryLabel
        required={!isViewer}
        error={errors.companyAddress}
        className={"mt-2 !text-lg"}
        label="Workplace Address"
      />
      <Note className={"mb-2"}>
        Note: Select the autocomplete results, even if you typed the address out
      </Note>
      <ControlledAddressCombobox
        isDisabled={isViewer}
        control={control}
        name={"companyAddress"}
        addressSelected={companyAddressHook.selectedAddress}
        addressSetter={companyAddressHook.setSelectedAddress}
        addressSuggestions={companyAddressHook.suggestions}
        error={errors.companyAddress}
        addressUpdater={companyAddressHook.updateAddress}
      />
      {errors.companyAddress && (
        <ErrorDisplay>{errors.companyAddress.message}</ErrorDisplay>
      )}
      <div className="font-montserrat py-8">
        <button
          type="button"
          className="bg-northeastern-red w-full rounded-lg py-3 text-lg text-white hover:bg-red-700"
          onClick={onSubmit}
        >
          Save Changes
        </button>
      </div>
    </div>
  );
};
export default CarpoolSection;
