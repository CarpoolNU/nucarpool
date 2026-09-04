import { TimePicker, ConfigProvider } from "antd";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
dayjs.extend(customParseFormat);
import utc from "dayjs/plugin/utc";
dayjs.extend(utc);
import { forwardRef, ReactNode } from "react";
import { Control, Controller, FieldError } from "react-hook-form";
import {
  scheduleClockOf,
  scheduleTimeFromClock,
} from "../../utils/scheduleTime";
import { OnboardingFormInputs } from "../../utils/types";
import { ErrorDisplay } from "../../styles/profile";
import * as React from "react";
interface ControlledTimePickerProps {
  control: Control<OnboardingFormInputs>;
  name: "startTime" | "endTime";
  placeholder?: string;
  value?: Date;
  isDisabled?: boolean;
  error?: FieldError;
}
/**
 * The stored value as a Dayjs carrying the same clock face, on an arbitrary
 * date. Only the time component is displayed, so the date is irrelevant — what
 * matters is that the hour and minute are the Boston ones rather than the
 * browser's reading of an epoch-dated instant.
 */
const clockFaceOf = (value: Date) => {
  const { hour, minute } = scheduleClockOf(value);
  return dayjs().hour(hour).minute(minute).second(0).millisecond(0);
};

const ControlledTimePicker = (props: ControlledTimePickerProps) => {
  const customSuffixIcon = (): ReactNode => {
    return (
      <div className="text-northeastern-red flex h-1/12 w-1/12 justify-center text-center text-xs">
        ▼
      </div>
    );
  };
  const TimePickerWrapper = forwardRef<
    HTMLDivElement,
    React.ComponentProps<typeof TimePicker>
  >((props, ref) => (
    <div ref={ref}>
      <TimePicker {...props} />
    </div>
  ));
  TimePickerWrapper.displayName = "TimePickerWrapper";

  return (
    <Controller
      name={props.name}
      control={props.control}
      render={({ field: { ref, ...fieldProps }, fieldState }) => {
        return (
          <ConfigProvider
            theme={{
              components: {
                DatePicker: {
                  fontWeightStrong: 500,
                  controlItemBgActive: "#FFA9A9",
                  cellHoverBg: "#FFE6E6",
                },
              },
              token: {
                fontFamily: "Montserrat",
                fontSize: 16,
                colorPrimary: "#C8102E",
              },
            }}
          >
            <div className={"flex flex-col"}>
              <TimePickerWrapper
                ref={ref}
                needConfirm={false}
                className="form-input w-full rounded-lg border border-black"
                format="h:mm A"
                suffixIcon={customSuffixIcon()}
                status={fieldState.error ? "error" : undefined}
                placeholder={props.placeholder}
                showNow={false}
                disabled={props.isDisabled}
                minuteStep={15}
                use12Hours={true}
                // Built from the stored clock face rather than handed the
                // stored `Date`. Rendering that `Date` resolves its zone in the
                // *browser's* locale, so one row showed 9:00 AM in Boston and
                // 2:00 PM on a machine set to UTC.
                value={fieldProps.value ? clockFaceOf(fieldProps.value) : null}
                inputReadOnly={true}
                // `.hour()` / `.minute()` read the face the user actually
                // pointed at, which is what a schedule means. `date.toDate()`
                // used to be stored instead, and that carried today's date —
                // so which `America/New_York` offset the value acquired
                // depended on whether the save happened under daylight saving.
                // `scheduleTimeFromClock` anchors it to the one date the read
                // path also uses. See SCRUM-373.
                onChange={(date) => {
                  fieldProps.onChange(
                    date
                      ? scheduleTimeFromClock(date.hour(), date.minute())
                      : null,
                  );
                }}
              />
              {props.error && (
                <ErrorDisplay>{props.error.message}</ErrorDisplay>
              )}
            </div>
          </ConfigProvider>
        );
      }}
    />
  );
};
export default ControlledTimePicker;
