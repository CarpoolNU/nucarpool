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
  formatDateToMonth,
  handleMonthPickerChange,
} from "../../utils/dateUtils";
import FormControlLabel from "@mui/material/FormControlLabel";
import { Switch } from "@mui/material";
import { DatePicker } from "antd";
import dayjs, { Dayjs } from "dayjs";

/**
 * A stored co-op date as the month picker's own value, or `null` when the field
 * is empty.
 *
 * **Controlled deliberately.** Both pickers used to take `defaultValue`, which
 * antd reads once at mount and ignores afterwards. `src/pages/profile/index.tsx`
 * calls `reset(...)` on every `user` change - which every save triggers, via a
 * refetch - and `AccountSection` stays mounted across it, since it is gated on
 * `option === "account"` at a fixed position in the tree with no `key`. So the
 * form moved to the saved months and the controls kept displaying the ones they
 * had started with: a user who had just saved was told their change had not
 * taken, which is the opposite of what the database held. `UnsavedModal`'s
 * discard is the same `reset(...)` and had the same outcome.
 *
 * **`null` rather than `undefined`, and the empty case never reaches `dayjs`.**
 * `formatDateToMonth(null)` is `undefined`, and `dayjs(undefined, format)` is
 * not empty either way: it is `Invalid Date` once `customParseFormat` is
 * extended - which `@rc-component/picker/generate/dayjs` does to the shared
 * dayjs singleton, so importing `DatePicker` above is enough - and *today*
 * when it is not. Neither is "no month chosen". `null` is antd's documented
 * empty value for a controlled picker, and is also what
 * `handleMonthPickerChange` writes when the field is cleared, so the round trip
 * is symmetric.
 *
 * The format matches what `formatDateToMonth` emits. The call site used to pass
 * `"YYYY/MM"` against its hyphenated output; dayjs parses it either way, so
 * that was latent rather than broken, but there is no reason for the two to
 * disagree. The month is parsed in local time and only ever rendered as
 * `YYYY-MM`, so the displayed month is the stored one in every zone - which is
 * why the suite gives the same answers under UTC and `America/New_York`.
 */
const toMonthPickerValue = (date: Date | null | undefined): Dayjs | null => {
  const month = formatDateToMonth(date ?? null);

  return month ? dayjs(month, "YYYY-MM") : null;
};

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
    <div
      className={`flex h-fit ${isMobile ? "w-full" : "w-[700px]"} flex-col justify-start`}
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

        {/* Date pickers stack on mobile for better fit */}
        <div
          className={`flex ${isMobile ? "flex-col gap-4" : "w-2/3 gap-8 lg:w-full"}`}
        >
          <div className="flex flex-1 flex-col">
            <EntryLabel
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
