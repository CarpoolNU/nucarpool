import { Control, FieldError, useWatch } from "react-hook-form";
import { OnboardingFormInputs } from "../../utils/types";
import { EntryLabel } from "../EntryLabel";
import ControlledTimePicker from "../Profile/ControlledTimePicker";
import { Note } from "../../styles/profile";
import { describeSchedule, scheduleOpenTime } from "../../utils/scheduleSpan";

interface TimeRangePickerProps {
  control: Control<OnboardingFormInputs>;
  errors?: {
    startTime?: FieldError;
    endTime?: FieldError;
  };
  isDisabled?: boolean;
  noteText?: string;
  noteClassName?: string;
  containerClassName?: string;
  showLabels?: boolean;
  timePickerValues?: {
    startTime?: Date | null;
    endTime?: Date | null;
  };
}

const SelectTimeRange = ({
  control,
  errors,
  isDisabled = false,
  noteText = "Please input the start and end times of your work, rather than your departure times. If your work hours are flexible, coordinate directly with potential riders or drivers to inform them.",
  noteClassName = "",
  containerClassName = "",
  showLabels = true,
  timePickerValues = {},
}: TimeRangePickerProps) => {
  // Each picker needs the other's current value: an empty one opens relative
  // to it, and the summary below states the pair. `useWatch` rather than the
  // parents' `watch`, so this re-renders on its own two fields only.
  const [startTime, endTime] = useWatch({
    control,
    name: ["startTime", "endTime"],
  });
  const schedule = describeSchedule(startTime, endTime);

  return (
    <>
      <div className={containerClassName}>
        {/* Start Time */}
        <div className="flex flex-1 flex-col gap-2">
          {showLabels && (
            <EntryLabel
              htmlFor="startTime"
              required={!isDisabled}
              error={errors?.startTime}
              label="Start Time"
            />
          )}
          <ControlledTimePicker
            id="startTime"
            isDisabled={isDisabled}
            control={control}
            name="startTime"
            error={errors?.startTime}
            value={timePickerValues.startTime || undefined}
            openValue={scheduleOpenTime("startTime", endTime)}
          />
        </div>

        {/* End Time */}
        <div className="flex flex-1 flex-col gap-2">
          {showLabels && (
            <EntryLabel
              htmlFor="endTime"
              required={!isDisabled}
              error={errors?.endTime}
              label="End Time"
            />
          )}
          <ControlledTimePicker
            id="endTime"
            isDisabled={isDisabled}
            control={control}
            name="endTime"
            error={errors?.endTime}
            value={timePickerValues.endTime || undefined}
            openValue={scheduleOpenTime("endTime", startTime)}
          />
        </div>
      </div>

      {/* The shift in words, so a wrong AM or PM shows before Save does:
          "9:00 AM to 5:00 AM the next day (20 hours)". A polite live region
          so a screen reader hears it after each pick, and present whenever
          the pickers are editable so the region exists before its text
          changes - one inserted with its text is not reliably announced. */}
      {!isDisabled && (
        <p aria-live="polite" className="font-montserrat w-full text-sm">
          {schedule ? `Your shift: ${schedule}` : ""}
        </p>
      )}

      {/* Note */}
      {noteText && (
        <div className="w-full">
          <Note className={noteClassName}>{noteText}</Note>
        </div>
      )}
    </>
  );
};

export default SelectTimeRange;
