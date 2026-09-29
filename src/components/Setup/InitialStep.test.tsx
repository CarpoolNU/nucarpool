/**
 * The Viewer radio used to be wrapped in `!isMobile`, so on a phone step 1
 * rendered only Rider and Driver - both drawing unselected whenever
 * `watch("role")` was VIEWER, with nothing on screen indicating what the
 * primary button was about to commit the user to. This pins that all three
 * roles render on mobile, and that the selected one always has a visible,
 * checked control there - never all three unselected.
 *
 * A second, separate defect: those same radios reported the wrong
 * accessible role. `FormRadioButton` spread its caller's props onto the native
 * `<input type="radio">`, and `InitialStep` passed `role={Role.X}` alongside
 * the `value` that actually drives selection - `role` is a real ARIA
 * attribute, not a naming collision with Prisma's `Role` enum, so it
 * overwrote the input's implicit `"radio"` role with the literal string
 * `"VIEWER"` / `"RIDER"` / `"DRIVER"`. `getByRole("radio", { name })` could
 * not find any of the three controls.
 */

import { render, screen } from "@testing-library/react";
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

describe("InitialStep on a mobile viewport", () => {
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

/**
 * SCRUM-592: the driver-only Seat Availability field was labelled by a plain
 * `<span>` with no association to the input, so it announced as an unnamed
 * spin button. `TextField`'s `label` prop looked like the fix but is never
 * rendered — SCRUM-513's own sweep threaded `htmlFor` through every
 * `EntryLabel` and had nothing to catch here.
 */
describe("InitialStep — Seat Availability accessible name", () => {
  it("names the spin button for a driver", () => {
    render(<Harness role={Role.DRIVER} />);

    // Positive control first: the control must be reachable before a name
    // query can mean anything — the exact trap SCRUM-475 and SCRUM-513 both
    // recorded.
    const spinbutton = screen.getByRole("spinbutton");
    expect(spinbutton).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /seat availability/i })).toBe(
      spinbutton,
    );
  });

  it("renders no seat availability control for a rider", () => {
    const { container } = render(<Harness role={Role.RIDER} />);

    // Positive assertion that the tree rendered at all, rather than a bare
    // `queryBy...toBeNull()` that would pass just as well on a crash.
    expect(screen.getByRole("radio", { name: "Rider" })).toBeInTheDocument();
    expect(container.querySelector("#seatAvail")).toBeNull();
  });
});

describe("the onboarding role radios", () => {
  it("are reachable as radios, not as their Role enum value", () => {
    render(<Harness role={Role.RIDER} />);

    expect(screen.getByRole("radio", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Rider" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Driver" })).toBeInTheDocument();
  });

  it("carries no explicit role attribute, leaving the browser's implicit one", () => {
    render(<Harness role={Role.RIDER} />);

    for (const name of ["Viewer", "Rider", "Driver"]) {
      const input = screen.getByLabelText(name, { selector: "input" });
      expect(input).not.toHaveAttribute("role");
    }
  });
});
