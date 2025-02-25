import { OnboardingFormInputs } from "../../utils/types";
import {
  UseFormWatch,
  FieldErrors,
  Control,
  Controller,
  UseFormSetValue,
} from "react-hook-form";

import { User } from "@prisma/client";
import Checkbox from "@mui/material/Checkbox";
import { ErrorDisplay, Note } from "../../styles/profile";
import { EntryLabel } from "../EntryLabel";
import ControlledTimePicker from "../Profile/ControlledTimePicker";
import { TextField } from "../TextField";
import { formatDateToMonth, handleMonthChange } from "../../utils/dateUtils";
import StaticDayBox from "../Sidebar/StaticDayBox";
import { DatePicker } from "antd";
import dayjs, {Dayjs} from "dayjs";


interface StepThreeProps {
  errors: FieldErrors<OnboardingFormInputs>;
  watch: UseFormWatch<OnboardingFormInputs>;
  control: Control<OnboardingFormInputs>;
  setValue: UseFormSetValue<OnboardingFormInputs>;
  user?: User;
}
const StepThree = ({
  errors,
  watch,
  user,
  control,
  setValue,
}: StepThreeProps) => {
  const daysOfWeek = ["Su", "M", "Tu", "W", "Th", "F", "S"];
  return (
    <div className="flex flex-col items-center  justify-center bg-white px-4 ">
      <div className="mb-8 text-center font-montserrat text-3xl font-bold">
        <span>When are you&nbsp;</span>
        <span className="text-northeastern-red">carpooling?</span>
      </div>
      <div
        className={`flex flex-col items-start  ${
          (errors.startTime || errors.endTime) &&
          (errors.coopStartDate || errors.coopEndDate)
            ? "space-y-0"
            : "space-y-4"
        } `}
      >
        <div className="flex flex-col space-y-2 ">
          <EntryLabel
            required={true}
            error={
              errors.daysWorking
                ? {
                    type: "custom",
                    message: "Please select at least one day.",
                  }
                : undefined
            }
            label="Days of the Week"
          />
          <div className="flex flex-row items-center ">
            {daysOfWeek.map((day, index) => (
              <Controller
                key={day + index.toString()}
                name={`daysWorking.${index}`}
                control={control}
                render={({ field: { onChange, value } }) => (
                  <Checkbox
                    key={day + index.toString()}
                    sx={{ padding: 0 }}
                    disabled={false}
                    checked={value}
                    onChange={onChange}
                    checkedIcon={
                      <StaticDayBox
                        className={"!h-12 !w-12"}
                        day={day}
                        isSelected={true}
                      />
                    }
                    icon={
                      <StaticDayBox
                        className={"!h-12 !w-12"}
                        day={day}
                        isSelected={false}
                      />
                    }
                  />
                )}
              />
            ))}
          </div>
          {errors.daysWorking && (
            <ErrorDisplay>{errors.daysWorking.message}</ErrorDisplay>
          )}
        </div>

        <div className="flex w-full  flex-col ">
          <div className="flex w-3/4 gap-8">
            {/* Start Time */}
            <div className="flex flex-1  flex-col ">
              <EntryLabel
                required={true}
                error={errors.startTime}
                label="Start Time"
              />
              <ControlledTimePicker
                isDisabled={false}
                control={control}
                name="startTime"
                error={errors.startTime}
                value={watch("startTime") || user?.startTime || undefined}
              />
            </div>

            {/* End Time */}
            <div className="flex flex-1 flex-col ">
              <EntryLabel
                required={true}
                error={errors.endTime}
                label="End Time"
              />
              <ControlledTimePicker
                isDisabled={false}
                control={control}
                name="endTime"
                error={errors.endTime}
                value={watch("endTime") || user?.endTime || undefined}
              />
            </div>
          </div>

          {/* Note for Time Section */}
          <div className="w-full">
            <Note className="py-2">
              Please input the start and end times of your work, rather than
              your departure times. If your work hours are flexible, coordinate
              directly with potential riders or drivers.
            </Note>
          </div>

          <div
            className={`flex w-3/4 ${
              !errors.startTime && !errors.endTime
                ? "pt-4"
                : errors.daysWorking && "!-mt-2"
            } gap-8`}
          >
            {/* Start Date */}
            <div className="flex flex-col w-1/2">
              <EntryLabel
                required={true}
                error={errors.coopStartDate}
                label="Start Date"
                className="w-full"
              />
              <DatePicker<Dayjs>
                id="coopStartDate"
                picker="month"
                onChange={(date : Dayjs, dateString) => setValue("coopStartDate", date ? date.toDate() : null)}
                format="YYYY-MM" 
                className="h-14 text-lg w-full border rounded-md p-2"
              />
            </div>

            {/* End Date */}
            <div className="flex flex-grow-0 flex-col w-1/2">
              <EntryLabel
                required={true}
                error={errors.coopEndDate}
                label="End Date"
              />
            <DatePicker<Dayjs>
              id="coopStartDate"
              picker="month"
              onChange={(date : Dayjs, dateString) => setValue("coopEndDate", date ? date.toDate() : null)}
              format="YYYY-MM" 
              className="h-14 text-lg w-full border rounded-md p-2"
            />
            </div>
          </div>
          {/* Note for Date Section */}
          <div className="w-full">
            <Note className="py-2">
              Please indicate the start and the end dates of your co-op. If you
              don&apos;t know exact dates, you can use approximate dates.
            </Note>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StepThree;
