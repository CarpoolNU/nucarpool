import { OnboardingFormInputs } from "../../utils/types";
import { FieldErrors, UseFormRegister, UseFormSetValue } from "react-hook-form";
import { Note } from "../../styles/profile";
import { EntryLabel } from "../EntryLabel";
import { TextField } from "../TextField";
import ProfilePicture from "../Profile/ProfilePicture";

interface StepFourProps {
  errors: FieldErrors<OnboardingFormInputs>;
  setValue: UseFormSetValue<OnboardingFormInputs>;
  register: UseFormRegister<OnboardingFormInputs>;
  onFileSelect: (file: File | null) => void;
}
const StepFour = ({ errors, register, onFileSelect }: StepFourProps) => {
  return (
    <div className="flex flex-col items-center  justify-center bg-white px-4">
      <div className="mb-4 text-center font-montserrat text-3xl font-bold">
        <span>Who is&nbsp;</span>
        <span className="text-northeastern-red">carpooling?</span>
      </div>
      {/* Pfp Section*/}

      <div className=" mb-2 w-full ">
        <ProfilePicture onFileSelected={onFileSelect} />
      </div>

      {/* About Me*/}
      <div className="flex w-full flex-row  space-x-6">
        {/* Preferred Name field  */}

        <div className="flex w-3/5 flex-col">
          <EntryLabel error={errors.preferredName} label="Preferred Name" />

          <TextField
            id="preferredName"
            error={errors.preferredName}
            isDisabled={false}
            type="text"
            inputClassName="h-12"
            {...register("preferredName")}
          />
        </div>

        {/* Pronouns field  */}
        <div className="w-2/6 flex-1">
          <EntryLabel error={errors.pronouns} label="Prounouns" />
          <TextField
            id="pronouns"
            inputClassName={`h-12`}
            error={errors.pronouns}
            isDisabled={false}
            type="text"
            {...register("pronouns")}
          />
        </div>
      </div>
      {/* Bio field */}
      <div className="w-full py-4">
        <EntryLabel error={errors.bio} label="About Me" />
        <textarea
          className="form-input w-full resize-none rounded-md border-black px-3 py-2"
          maxLength={188}
          disabled={false}
          {...register("bio")}
        />
        <Note>
          This intro will be shared with people you choose to connect with.
        </Note>
      </div>
    </div>
  );
};

export default StepFour;