import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import StepFour from "./StepFour";
import { OnboardingFormInputs } from "../../utils/types";
import {
  PROFILE_TEXT_MAX_LENGTH,
  PRONOUNS_INPUT_MAX_LENGTH,
  PRONOUNS_MAX_LENGTH,
} from "../../utils/textLimits";

/**
 * `EntryLabel` had no `htmlFor`, and the "About Me" `<textarea>` had no `id`
 * at all, so none of this step's three fields announced a name a
 * screen reader could use - despite the visible label text beside each one.
 */

jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

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

/**
 * The pronouns input's cap.
 *
 * `charLimit` becomes the input's `maxLength`, and this is the one field whose
 * displayed value is not its stored value: both call sites wrap it in
 * parentheses for display and strip them again before storing.
 * `charLimit={20}` therefore left room for 18 typed characters, not 20 - so
 * the field's real cap disagreed with the number written at the call site, and
 * with the way every other `charLimit` here is used, where it is a stored
 * length.
 */
describe("the pronouns field's character cap", () => {
  it("allows PRONOUNS_MAX_LENGTH stored characters, counting the parentheses", () => {
    render(<Harness />);

    const pronouns = screen.getByRole("textbox", {
      name: "Pronouns",
    }) as HTMLInputElement;

    expect(pronouns.maxLength).toBe(PRONOUNS_INPUT_MAX_LENGTH);
    // The arithmetic that is easy to get wrong, stated as the property that
    // matters: the cap is what the user can type, after the two characters
    // the display wrapper spends.
    expect(pronouns.maxLength - 2).toBe(PRONOUNS_MAX_LENGTH);
    expect(PRONOUNS_MAX_LENGTH).toBe(20);
  });

  it("stays well inside the column, so the UI is the only constraint", () => {
    // `pronouns` is `VARCHAR(191)`. Inverted, the input would accept text the
    // write then rejects.
    expect(PRONOUNS_INPUT_MAX_LENGTH).toBeLessThan(PROFILE_TEXT_MAX_LENGTH);
  });
});

describe("StepFour accessible names", () => {
  it("names every field after its visible label", () => {
    render(<Harness />);

    expect(
      screen.getByRole("textbox", { name: "Preferred Name" }),
    ).toBeInTheDocument();
    // Was "Prounouns": the label carried that typo, and this assertion was
    // written against it.
    expect(
      screen.getByRole("textbox", { name: "Pronouns" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "About Me" }),
    ).toBeInTheDocument();
  });
});
