import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import StepFour from "./StepFour";
import { OnboardingFormInputs } from "../../utils/types";

/**
 * SCRUM-513. `EntryLabel` had no `htmlFor`, and the "About Me" `<textarea>`
 * had no `id` at all, so none of this step's three fields announced a name a
 * screen reader could use - despite the visible label text beside each one.
 */

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    isLoading: false,
  }),
}));

const Harness = () => {
  const { register, watch, setValue, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: { preferredName: "", pronouns: "", bio: "" },
    });

  return (
    <StepFour
      errors={formState.errors}
      register={register}
      setValue={setValue}
      watch={watch}
      onFileSelect={() => undefined}
      selectedFile={null}
    />
  );
};

describe("StepFour accessible names", () => {
  it("names every field after its visible label", () => {
    render(<Harness />);

    expect(
      screen.getByRole("textbox", { name: "Preferred Name" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Prounouns" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "About Me" }),
    ).toBeInTheDocument();
  });
});
