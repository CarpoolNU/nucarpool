import useIsMobile from "../../utils/useIsMobile";
import { ErrorDisplay, Note, ProfileHeader } from "../../styles/profile";
import { Role, Status } from "@prisma/client";
import { EntryLabel } from "../EntryLabel";
import {
  Control,
  Controller,
  FieldErrors,
  UseFormHandleSubmit,
  UseFormSetValue,
  UseFormWatch,
} from "react-hook-form";
import { OnboardingFormInputs } from "../../utils/types";
import {
  handleMonthPickerChange,
  toMonthPickerValue,
} from "../../utils/dateUtils";
import FormControlLabel from "@mui/material/FormControlLabel";
import { Switch } from "@mui/material";
import { DatePicker } from "antd";
import { Dayjs } from "dayjs";

interface AccountSectionProps {
  errors: FieldErrors<OnboardingFormInputs>;
  setValue: UseFormSetValue<OnboardingFormInputs>;
  watch: UseFormWatch<OnboardingFormInputs>;
  onSubmit: ReturnType<UseFormHandleSubmit<OnboardingFormInputs>>;
  control: Control<OnboardingFormInputs>;
}

const AccountSection = ({
  errors,
  watch,
  onSubmit,
  control,
  setValue,
}: AccountSectionProps) => {
  const isMobile = useIsMobile();
  const isViewer = watch("role") === Role.VIEWER;

  return (
    /* `max-w-full` is what makes the 700px a preference rather than a floor,
       and it is the one thing `UserSection`'s identical row already has. The
       declared width never fits: this section's container is the profile
       page's `max-w-2xl` reading column, so the box it is given is 608px at
       1440x900 and 353px at 667x375. Uncapped it simply overflowed both - on
       a desktop into a wide enough column that nothing clipped, and on a
       landscape phone off the side of the screen, where the column's
       `overflow-x-hidden` meant no gesture reached the End Date picker or
       most of Save Changes. See SCRUM-490 for the measurements. */
    <div
      className={`flex h-fit ${isMobile ? "w-full" : "w-[700px]"} max-w-full flex-col justify-start`}
    >
      <ProfileHeader className={isMobile ? "!text-2xl" : "!text-4xl"}>
        Account Status
      </ProfileHeader>

      <span>
        Profile is currently{" "}
        <span className="font-bold">
          {watch("status") === Status.ACTIVE ? "ACTIVE" : "INACTIVE"}{" "}
        </span>
      </span>

      <div className="mt-2 w-full">
        {!isViewer && (
          <Controller
            name="status"
            control={control}
            render={({ field }) => (
              <div className="font-montserrat flex flex-col items-start">
                <FormControlLabel
                  className="mt-4 mb-6 pl-3"
                  control={
                    <Switch
                      checked={field.value === Status.ACTIVE}
                      onChange={(e) =>
                        field.onChange(
                          e.target.checked ? Status.ACTIVE : Status.INACTIVE,
                        )
                      }
                      color="default"
                      sx={{
                        overflow: "visible",
                        scale: 1.5,
                        "& .MuiSwitch-switchBase.Mui-checked": {
                          color: "white",
                          hover: "none",
                          "& + .MuiSwitch-track": {
                            backgroundColor: "#C8102E",
                            opacity: 1,
                          },
                        },
                        "& .MuiSwitch-track": {
                          backgroundColor: "#bdbdbd",
                        },
                      }}
                      slotProps={{
                        input: {
                          "aria-label": "Mark profile inactive",
                        },
                      }}
                    />
                  }
                  label=""
                />

                <Note className="font-lato w-full !text-base !text-black">
                  Marking your profile inactive will make you invisible on the
                  map and disables sending messages from this profile. Profiles
                  are automatically marked inactive at the end of the of the
                  user&apos;s co-op period.
                </Note>
              </div>
            )}
          />
        )}

        <EntryLabel
          label="Co-op Term Dates"
          className={"mt-12 mb-6 !text-2xl"}
        />

        {/* Date pickers stack on mobile for better fit.
            The desktop arm used to take two thirds of the row below 1440px and
            the whole of it at or above - which is backwards, because the
            narrower the column the less a fraction of it leaves. Capping the
            section above made that visible: two thirds of the capped 338px
            gives each picker 96.66px, and at that width "Start Date" and "End
            Date" both wrap onto a second line in Montserrat at the 18px the
            label asks for. The full row gives each 153px and one line. The
            fraction was only ever applied between 640px and 1440px, and the
            full width is what the layout already resolved to above that, so
            this makes the wide-desktop arrangement the single arrangement
            rather than inventing one. Measured for SCRUM-490. */}
        <div className={`flex ${isMobile ? "flex-col gap-4" : "w-full gap-8"}`}>
          <div className="flex flex-1 flex-col">
            <EntryLabel
              htmlFor="coopStartDate"
              required={!isViewer}
              error={errors.coopStartDate}
              label="Start Date"
              className={"!text-lg"}
            />
            <DatePicker<Dayjs>
              id="coopStartDate"
              picker="month"
              disabled={isViewer}
              value={toMonthPickerValue(watch("coopStartDate"))}
              onChange={handleMonthPickerChange("coopStartDate", setValue)}
              format="YYYY-MM"
              // Matches `StepThree`'s two identical pickers and
              // `ControlledTimePicker`. Without it antd renders a focusable
              // text input, so a tap opens the soft keyboard as well as the
              // month panel - and the keyboard covers the panel it opened.
              // The field is only ever set by picking a month, so there is no
              // typed entry to lose.
              inputReadOnly={true}
              className="h-14 w-full rounded-md border border-gray-200 p-2 text-lg"
            />
          </div>

          <div className="flex flex-1 flex-col">
            <EntryLabel
              htmlFor="coopEndDate"
              required={!isViewer}
              error={errors.coopEndDate}
              label="End Date"
              className={"!text-lg"}
            />
            <DatePicker<Dayjs>
              id="coopEndDate"
              picker="month"
              disabled={isViewer}
              value={toMonthPickerValue(watch("coopEndDate"))}
              onChange={handleMonthPickerChange("coopEndDate", setValue)}
              format="YYYY-MM"
              // Read-only for the same reason as the start picker above.
              inputReadOnly={true}
              className="h-14 w-full rounded-md border border-gray-200 p-2 text-lg"
            />
          </div>
        </div>

        {/* The reason a range was rejected, not just a red label. Ordering is
            the one date error whose message a user cannot infer. */}
        {errors.coopEndDate?.message && (
          <ErrorDisplay className="pt-2">
            {errors.coopEndDate.message}
          </ErrorDisplay>
        )}

        <Note className="py-2">
          Please indicate the start and the end dates of your co-op. If you
          don&apos;t know exact dates, you can use approximate dates.
        </Note>

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
    </div>
  );
};

export default AccountSection;
