/**
 * SCRUM-521: the onboarding role radios reported the wrong accessible role.
 *
 * `FormRadioButton` spread its caller's props onto the native
 * `<input type="radio">`, and `InitialStep` passed `role={Role.X}` alongside
 * the `value` that actually drives selection - `role` is a real ARIA
 * attribute, not a naming collision with Prisma's `Role` enum, so it
 * overwrote the input's implicit `"radio"` role with the literal string
 * `"VIEWER"` / `"RIDER"` / `"DRIVER"`. `getByRole("radio", { name })` could
 * not find any of the three controls.
 */

import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import InitialStep from "./InitialStep";
import { OnboardingFormInputs } from "../../utils/types";

/**
 * A real `useForm`, the same reasoning as `UserSection.test.tsx`'s `Harness`:
 * `InitialStep` takes `register`, `watch` and `setValue` as props, and
 * `registerRoleWithSeatDefault` drives all three, so mocking that shape would
 * assert against the mock rather than the wiring.
 */
const Harness = () => {
  const { register, watch, setValue, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: {
        role: Role.RIDER,
        status: Status.ACTIVE,
        seatAvail: 0,
      },
    });

  return (
    <InitialStep
      handleNextStep={() => undefined}
      step={1}
      register={register}
      errors={formState.errors}
      watch={watch}
      setValue={setValue}
    />
  );
};

describe("the onboarding role radios", () => {
  it("are reachable as radios, not as their Role enum value", () => {
    render(<Harness />);

    // jsdom's default `window.innerWidth` is desktop-width (1024), so
    // `useIsMobile` is false and the Viewer radio - gated on `!isMobile` -
    // renders alongside Rider and Driver.
    expect(screen.getByRole("radio", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Rider" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Driver" })).toBeInTheDocument();
  });

  it("carries no explicit role attribute, leaving the browser's implicit one", () => {
    render(<Harness />);

    for (const name of ["Viewer", "Rider", "Driver"]) {
      const input = screen.getByLabelText(name, { selector: "input" });
      expect(input).not.toHaveAttribute("role");
    }
  });
});
