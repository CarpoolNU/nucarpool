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
import { fieldErrorId } from "../../utils/formA11y";
import * as React from "react";

/**
 * The only control that writes `startTime`/`endTime`, used twice from
 * `SelectTimeRange`.
 *
 * **Both ends of the conversion live in `utils/scheduleTime.ts`, deliberately.**
 * Calling `date.toDate()` on the way out and `dayjs(value)` on the way in
 * would resolve Boston's UTC offset from two different dates — the picker's
 * own anchor going out, the browser's zone coming in — so a 9:00 AM saved in
 * July would store an hour earlier than the same 9:00 AM saved in January,
 * and every DST-era schedule would read back an hour early. Going through the
 * helpers pins both directions to `SCHEDULE_ANCHOR_DATE`, so the round trip is
 * exact and neither the season nor the viewer's timezone can affect it.
 */
/**
 * The wrapper antd's `TimePicker` needs to accept a `ref`, at module scope.
 *
 * **Module scope is load-bearing: it must not be declared inside
 * `ControlledTimePicker`'s body.** That would make it a new function identity
 * on every render, and React compares `element.type` by identity, so a new one
 * is a *different component*: the tree would be unmounted and a fresh
 * `TimePicker` mounted in its place on every parent render. The panel is the
 * picker's own internal state, so it would close on the render that picking an
 * hour causes, and focus would go with it - leaving the control unable to pick
 * a time, which is the only thing it is for.
 *
 * At module scope the identity is fixed for the life of the module, so a
 * parent render reconciles the same component and the panel survives. It also
 * keeps the wrapper's own `props` from shadowing the outer component's.
 *
 * `forwardRef` because this is what `Controller`'s `field.ref` attaches to.
 * antd's picker does not forward a DOM ref itself, so the ref lands on this
 * wrapping element and react-hook-form has something to focus.
 */
const TimePickerWrapper = forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof TimePicker>
>((props, ref) => (
  <div ref={ref}>
    <TimePicker {...props} />
  </div>
));
TimePickerWrapper.displayName = "TimePickerWrapper";

interface ControlledTimePickerProps {
  control: Control<OnboardingFormInputs>;
  name: "startTime" | "endTime";
  id?: string;
  placeholder?: string;
  value?: Date;
  isDisabled?: boolean;
  error?: FieldError;
}
const ControlledTimePicker = (props: ControlledTimePickerProps) => {
  const errorId = props.error && props.id ? fieldErrorId(props.id) : undefined;
  const customSuffixIcon = (): ReactNode => {
    return (
      <div className="text-northeastern-red flex h-1/12 w-1/12 justify-center text-center text-xs">
        ▼
      </div>
    );
  };
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
                id={props.id}
                needConfirm={false}
                className="form-input w-full rounded-lg border border-black"
                format="h:mm A"
                suffixIcon={customSuffixIcon()}
                status={fieldState.error ? "error" : undefined}
                aria-invalid={props.error ? true : undefined}
                aria-describedby={errorId}
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
                <ErrorDisplay id={errorId} role="alert">
                  {props.error.message}
                </ErrorDisplay>
              )}
            </div>
          </ConfigProvider>
        );
      }}
    />
  );
};
export default ControlledTimePicker;
