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
import useIsMobile from "../../utils/useIsMobile";

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
  const isMobile = useIsMobile();
  
  return (
    <div className="flex flex-col items-center justify-center bg-white px-2">
      <div className={`mb-4 text-center font-montserrat ${isMobile ? 'text-2xl' : 'text-3xl'} font-bold`}>
        <span>When are you&nbsp;</span>
        <span className="text-northeastern-red">carpooling?</span>
      </div>
      
      <div className="flex flex-col items-start space-y-2 w-full">
        {/* Days of the Week */}
        <div className="flex flex-col space-y-1 w-full">
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
          <div className="flex flex-row items-center justify-center w-full">
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
                        className={`${isMobile ? '!h-8 !w-8' : '!h-10 !w-10'}`}
                        day={day}
                        isSelected={true}
                      />
                    }
                    icon={
                      <StaticDayBox
                        className={`${isMobile ? '!h-8 !w-8' : '!h-10 !w-10'}`}
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
            <ErrorDisplay className="text-xs">{errors.daysWorking.message}</ErrorDisplay>
          )}
        </div>

        {/* Time Section */}
        <div className={`flex w-full flex-col ${isMobile ? 'mt-2' : 'mt-3'}`}>
          <div className="flex w-full gap-4">
            {/* Start Time */}
            <div className="flex flex-1 flex-col">
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
            <div className="flex flex-1 flex-col">
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
            <Note className={`py-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>
              Please input the start and end times of your work, rather than
              your departure times.
            </Note>
          </div>
        </div>

        {/* Date Section */}
        <div className={`flex w-full gap-4 ${isMobile ? 'mt-1' : 'mt-2'}`}>
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
              className={`${isMobile ? 'h-10 text-base' : 'h-12 text-lg'} w-full border rounded-md p-2`}
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
              id="coopEndDate"
              picker="month"
              onChange={(date : Dayjs, dateString) => setValue("coopEndDate", date ? date.toDate() : null)}
              format="YYYY-MM" 
              className={`${isMobile ? 'h-10 text-base' : 'h-12 text-lg'} w-full border rounded-md p-2`}
            />
          </div>
        </div>
        
        {/* Note for Date Section */}
        <div className="w-full">
          <Note className={`py-1 ${isMobile ? 'text-xs' : 'text-sm'}`}>
            Please indicate the start and end dates of your co-op. Approximate dates are acceptable.
          </Note>
        </div>
      </div>
      
      {isMobile && (
        <div className="mt-2 w-full rounded-md bg-amber-50 p-1 text-center">
          <p className="text-xs font-medium text-amber-800">
            ⚠️ Mobile version is currently under development.
          </p>
        </div>
      )}
    </div>
  );
};

export default StepThree;