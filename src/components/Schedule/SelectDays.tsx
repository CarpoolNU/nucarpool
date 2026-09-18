import Checkbox from "@mui/material/Checkbox";
import { Controller, Control, FieldError, Merge } from "react-hook-form";
import { OnboardingFormInputs } from "../../utils/types";
import DayBox from "../Profile/DayBox";
import StaticDayBox from "../Sidebar/StaticDayBox";

interface SelectDaysProps {
  control: Control<OnboardingFormInputs>;
  disabled?: boolean;
  useStaticDayBox?: boolean;
  dayBoxClassName?: string;
  error?: Merge<FieldError, (FieldError | undefined)[]> | undefined;
}

const SelectDays = ({
  control,
  disabled = false,
  useStaticDayBox = false,
  dayBoxClassName = "",
  error,
}: SelectDaysProps) => {
  const daysOfWeek = ["Su", "M", "Tu", "W", "Th", "F", "S"];

  /*
   * Both boxes must accept `className`, because `dayBoxClassName` below is the
   * only way a caller can size them - `CarpoolSection` shrinks them under the
   * mobile breakpoint and `StepThree` sizes them at both.
   *
   * **That requirement is not enforceable by the type checker, and this is the
   * bug that taught us so.** `DayBox` declared no `className` prop for as long
   * as this forwarding existed; the JSX below still compiled, because excess
   * property checking against a union of component types admits a prop that
   * any one member declares - `StaticDayBox` did. Annotating this binding as
   * `ComponentType<{... className: string}>` does not help either: parameter
   * bivariance makes a component that takes only `{day, isSelected}` assignable
   * to it, since ignoring a prop is not a type error. TypeScript can require
   * that a component *declare* `className` only at the component's own
   * declaration site, and can never require that it *apply* it.
   *
   * So the guard is a test, not a type: `DayBox.test.tsx` renders through this
   * component and asserts the forwarded class reaches the rendered box on both
   * branches. A new box that drops `className` fails there.
   */
  const DayBoxComponent = useStaticDayBox ? StaticDayBox : DayBox;

  return (
    <>
      <div className="flex w-full items-center justify-evenly">
        {daysOfWeek.map((day, index) => (
          <Controller
            key={day + index.toString()}
            name={`daysWorking.${index}`}
            control={control}
            render={({ field: { onChange, value } }) => (
              <Checkbox
                key={day + index.toString()}
                sx={{
                  input: { width: 1, height: 1 },
                  aspectRatio: 1,
                  width: 1,
                  height: 1,
                  padding: 0,
                }}
                slotProps={{ input: { "aria-label": day } }}
                disabled={disabled}
                checked={value}
                onChange={onChange}
                checkedIcon={
                  <DayBoxComponent
                    className={dayBoxClassName}
                    day={day}
                    isSelected={true}
                  />
                }
                icon={
                  <DayBoxComponent
                    className={dayBoxClassName}
                    day={day}
                    isSelected={false}
                  />
                }
              />
            )}
          />
        ))}
      </div>
    </>
  );
};

export default SelectDays;
