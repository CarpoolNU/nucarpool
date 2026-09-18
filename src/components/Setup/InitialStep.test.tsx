/**
 * SCRUM-508: the Viewer radio used to be wrapped in `!isMobile`, so on a
 * phone step 1 rendered only Rider and Driver - both drawing unselected
 * whenever `watch("role")` was VIEWER, with nothing on screen indicating
 * what the primary button was about to commit the user to. This pins that
 * all three roles render on mobile, and that the selected one always has a
 * visible, checked control there - never all three unselected.
 */

import { render } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Role } from "@prisma/client";
import InitialStep from "./InitialStep";
import { OnboardingFormInputs } from "../../utils/types";
import {
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

restoreViewportAfterEach();

/** A minimal host so `InitialStep` gets real react-hook-form bindings. */
const Harness = ({ role }: { role: Role }) => {
  const { register, watch, setValue, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: { role },
    });
  return (
    <InitialStep
      handleNextStep={() => {}}
      step={1}
      register={register}
      errors={formState.errors}
      watch={watch}
      setValue={setValue}
    />
  );
};

const radioFor = (container: HTMLElement, id: "viewer" | "rider" | "driver") =>
  container.querySelector<HTMLInputElement>(`#${id}`);

describe("InitialStep on a mobile viewport (SCRUM-508)", () => {
  beforeEach(() => setViewportWidth(MOBILE_WIDTH));

  it("renders the Viewer radio, not only Rider and Driver", () => {
    const { container } = render(<Harness role={Role.RIDER} />);

    expect(radioFor(container, "viewer")).not.toBeNull();
    expect(radioFor(container, "rider")).not.toBeNull();
    expect(radioFor(container, "driver")).not.toBeNull();
  });

  it.each([Role.VIEWER, Role.RIDER, Role.DRIVER])(
    "leaves exactly one rendered radio checked for role %s",
    (role) => {
      const { container } = render(<Harness role={role} />);

      const checked = (["viewer", "rider", "driver"] as const).filter(
        (id) => radioFor(container, id)!.checked,
      );
      expect(checked).toHaveLength(1);
    },
  );
});
