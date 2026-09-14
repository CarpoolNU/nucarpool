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

      <div className="@container mb-2 w-full max-w-[360px] md:my-4 md:max-w-[448px] lg:max-w-[504px]">
        {/*
          Seven boxes at the base 40px plus 8px of `ml-2` each need 336px. The
          mobile profile content is inset `px-8`, so a 375px phone offers 311px
          and a 360px one 296px - the row overflowed both, and since the
          scroller above sets `overflow-y-auto` with the x-axis left visible,
          CSS computes that axis to `auto` and the whole tab panned sideways.
          Measured at 360px, the seventh day ended 40px past the column and the
          clipped part of it answered no clicks at all.

          32px puts the row at 7 x 40px = 280px, inside both widths. The `ml-2`
          gap is kept rather than traded away: a checkbox never shrinks below
          its box plus that gap - see the paragraph on the cap below - so
          narrowing the gap would only narrow every hit area.

          **`max-desktop:` is doing specific work.** It compiles to
          `@media (width < 640px)`, which is disjoint from the `md:` (834px)
          and `lg:` (1440px) sizes `DayBox` carries, so the two can never both
          apply and the desktop ladder is untouched. An unconditional
          `!h-8 !w-8` - what `StepThree` passes, correctly, to a `StaticDayBox`
          that has no such ladder - would have overridden `md:h-14` and
          `lg:h-16` at every width and shrunk the desktop picker.

          This only does anything because `DayBox` now declares `className`;
          until it did, the prop was accepted, type-checked and dropped.

          **The cap is per-size because the row's width is not negotiable.**
          Each MUI `Checkbox` is `width: 1` and shrinks like any other flex
          item, but its automatic minimum size is content-based and its content
          is a fixed-width `DayBox` plus that 8px margin - so it floors at
          box + 8px and goes no lower. Measured in a browser: 48px at the 40px
          base, 64px against `md:h-14`, 72px against `lg:h-16`. Two things
          follow. The hit area and the circle drawn inside it coincide at every
          width, so the boxes cannot overlap and a click cannot land on the
          neighbouring day. And a cap below 7 x (box + 8px) does not compress
          the row, it is simply overflowed: `max-w-[360px]` was exceeded by
          88px at `md`, and by 224px at `lg` once the 80px of left padding
          this wrapper used to carry there had come out of it.

          So each size now caps at what that size's row actually occupies -
          336px fits inside the 360px the base keeps for mobile, `md` needs
          7 x 64 = 448px and `lg` 7 x 72 = 504px, both of which the column has
          room for. That `lg` padding goes with it: it indented the row 88px
          past the labels, address fields and save button below, which all sit
          flush with the column's left edge. Nothing moves at `md`, where the
          boxes already fell inside the column - what changes there is that the
          declared cap stops being a number the row ignores.

          The retired padding utility is described rather than written out, for
          the reason the explore-page offset gives: Tailwind v4 scans this file
          for class-like strings, so naming it here would keep emitting it and
          would put a false hit in front of anyone grepping for live uses.

          **The container query is the second shrink rule, and it exists
          because a cap cannot create space that is not there.** Everything
          above reasons about the viewport, and that is what left a band of
          widths where the row was clipped rather than capped. From 640px to
          649px the page has already switched to the desktop grid, so the
          250px sidebar is out of the column while `md:` has not started: the
          column measures `min(672, viewport - 250) - 64`, which is 326px at
          640px and does not reach 336px until 650px. `max-desktop:` has
          stopped applying by then, so the row is at its 40px base in the
          narrowest desktop column that exists, and the seventh day hangs 10px
          past a scroller that is `overflow-x-hidden` - clipped, not
          scrollable, and that strip answered no clicks.

          `@max-[336px]:` asks the wrapper how wide it actually is instead of
          asking the viewport, so it fires exactly when the row would not fit
          and never otherwise. It is deliberately not a second viewport
          breakpoint: a 650px one would restate `250 + 64 + 336` as a magic
          number that drifts the moment the sidebar or the inset changes, and
          it would still miss the case the measurement turned up - a classic
          (non-overlay) scrollbar on the vertical scroller, which narrows the
          column without moving the viewport.

          Both rules are kept, because they say different things.
          `max-desktop:` is the deliberate mobile treatment SCRUM-430 chose,
          and it is why 639px keeps its 32px boxes even though 360px of
          wrapper would hold the 40px ones. The container query is a floor
          under every width: it cannot fire at `md` or `lg`, where the wrapper
          caps at exactly the 448px and 504px those rows occupy and the column
          is wider than both, and if a future change ever did squeeze it, the
          important flag means the row shrinks rather than clips.

          Tailwind v4 has container queries in core, so `@container` here is
          the whole cost - no plugin, and no `ResizeObserver` to stub in jsdom.
          This is the repository's first use of one.
        */}
        <SelectDays
          control={control}
          disabled={isViewer}
          dayBoxClassName="max-desktop:!h-8 max-desktop:!w-8 @max-[336px]:!h-8 @max-[336px]:!w-8"
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
