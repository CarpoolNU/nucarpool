import { TimePicker, ConfigProvider } from "antd";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
dayjs.extend(customParseFormat);
import { forwardRef, ReactNode } from "react";
import { Control, Controller, FieldError } from "react-hook-form";
import { OnboardingFormInputs } from "../../utils/types";
import { ErrorDisplay } from "../../styles/profile";
import {
  toPickerScheduleTime,
  toStoredScheduleTime,
} from "../../utils/scheduleTime";
import * as React from "react";

/**
 * The only control that writes `startTime`/`endTime`, used twice from
 * `SelectTimeRange`.
 *
 * **Both ends of the conversion live in `utils/scheduleTime.ts`, deliberately.**
 * This component used to call `date.toDate()` on the way out and
 * `dayjs(value)` on the way in, which resolved Boston's UTC offset from two
 * different dates — the picker's own anchor going out, the browser's zone
 * coming in. That is SCRUM-373: a 9:00 AM saved in July stored an hour earlier
 * than the same 9:00 AM saved in January, and every DST-era schedule read back
 * an hour early. Going through the helpers pins both directions to
 * `SCHEDULE_ANCHOR_DATE`, so the round trip is exact and neither the season nor
 * the viewer's timezone can affect it.
 */
interface ControlledTimePickerProps {
  control: Control<OnboardingFormInputs>;
  name: "startTime" | "endTime";
  placeholder?: string;
  value?: Date;
  isDisabled?: boolean;
  error?: FieldError;
}
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
                value={toPickerScheduleTime(fieldProps.value)}
                inputReadOnly={true}
                onChange={(date) => {
                  fieldProps.onChange(toStoredScheduleTime(date));
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
