/**
 * All three roles render on mobile, and the selected one always has a visible,
 * checked control there - never all three unselected. Wrapping the Viewer
 * radio in `!isMobile` leaves a phone's step 1 showing only Rider and Driver,
 * both drawing unselected whenever `watch("role")` is VIEWER, with nothing on
 * screen indicating what the primary button is about to commit the user to.
 *
 * The radios also have to report the right accessible role. `FormRadioButton`
 * spreads its caller's props onto the native `<input type="radio">`, so
 * passing `role={Role.X}` alongside the `value` that drives selection would
 * overwrite the input's implicit `"radio"` role with the literal string
 * `"VIEWER"` / `"RIDER"` / `"DRIVER"` - `role` is a real ARIA attribute, not a
 * naming collision with Prisma's `Role` enum - and `getByRole("radio",
 * { name })` would find none of the three controls.
 */

import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Role } from "@prisma/client";
import InitialStep from "./InitialStep";
import { OnboardingFormInputs } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

restoreViewportAfterEach();

/**
 * A minimal host so `InitialStep` gets real react-hook-form bindings.
 *
 * `step` defaults to 1 - the role picker - because that is the step most of
 * this file asserts against. It is a parameter rather than a constant because
 * `InitialStep` renders different things at 0 and 1, and the banner this
 * component used to draw was gated on neither.
 */
const Harness = ({ role, step = 1 }: { role: Role; step?: number }) => {
  const { register, watch, setValue, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: { role },
    });
  return (
    <InitialStep
      handleNextStep={() => {}}
      step={step}
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
 * The driver-only Seat Availability field is named by a label associated with
 * the input. A plain `<span>` beside it announces as an unnamed spin button,
 * and `TextField`'s `label` prop looks like the answer but is never rendered —
 * so a sweep threading `htmlFor` through every `EntryLabel` has nothing to
 * catch here.
 */
describe("InitialStep — Seat Availability accessible name", () => {
  it("names the spin button for a driver", () => {
    render(<Harness role={Role.DRIVER} />);

    // Positive control first: the control must be reachable before a name
    // query can mean anything.
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

/**
 * SCRUM-711. The wizard used to tell every mobile visitor that "Mobile version
 * is currently under development. Some features are only available on
 * Desktop", on both the welcome screen and the role picker - the banner was
 * gated on `isMobile` alone, outside the `step` blocks, so it drew on each.
 *
 * SCRUM-503 retired that claim on `/` and SCRUM-522 removed it from
 * `ConnectModal`; neither reached the wizard, and the product decision
 * recorded on SCRUM-711 extends them here. `/admin` is the only capability a
 * phone genuinely lacks, and it is permission-gated.
 *
 * Each case asserts a positive control first. "The string is absent" passes
 * just as well on a tree that failed to render at all, and the control is
 * what separates the two.
 */
describe("InitialStep on a mobile viewport - no under-development claim", () => {
  beforeEach(() => setViewportWidth(MOBILE_WIDTH));

  const DEVELOPMENT_CLAIM = /under development/i;

  it("renders no such claim on the welcome screen", () => {
    render(<Harness role={Role.VIEWER} step={0} />);

    // Control: step 0 really did render, so the query below means something.
    expect(
      screen.getByRole("button", { name: "Get Started" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(DEVELOPMENT_CLAIM)).toBeNull();
  });

  it("renders no such claim on the role picker", () => {
    render(<Harness role={Role.VIEWER} step={1} />);

    expect(screen.getByRole("radio", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.queryByText(DEVELOPMENT_CLAIM)).toBeNull();
  });
});

/**
 * The role-picker heading was sized `text-l` on mobile, which is not a utility
 * in Tailwind's scale and which `tailwind.config.js` does not define either -
 * it declares no `fontSize` key at all. The mobile branch therefore applied no
 * font-size rule and the heading rendered at the inherited size.
 *
 * This asserts the class **actually applied**, never the absence of the broken
 * one. A negative class assertion would be the wrong shape twice over:
 * Tailwind v4 scans this file, so naming a utility in one ships it as dead
 * CSS - and the assertion would have passed against the bug, because the class
 * was always absent from the compiled output. That absence *was* the defect.
 *
 * Matching the whole size token rather than asserting only the expected one
 * also catches a second size arriving alongside it, which `toHaveClass` would
 * not.
 */
describe("InitialStep role-picker heading size", () => {
  const SIZE_TOKEN = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/;

  const sizeClassesOf = (element: HTMLElement) =>
    Array.from(element.classList).filter((name) => SIZE_TOKEN.test(name));

  const roleHeading = () =>
    screen.getByRole("heading", { name: /please select a role/i });

  it("gives the heading exactly one real size class on mobile", () => {
    setViewportWidth(MOBILE_WIDTH);
    render(<Harness role={Role.VIEWER} />);

    // One step down from the desktop `text-2xl`, matching the Get Started
    // button directly above this heading, which already pairs with that same
    // desktop size.
    expect(sizeClassesOf(roleHeading())).toEqual(["text-xl"]);
  });

  it("leaves the desktop heading at its existing size", () => {
    setViewportWidth(DESKTOP_WIDTH);
    render(<Harness role={Role.VIEWER} />);

    expect(sizeClassesOf(roleHeading())).toEqual(["text-2xl"]);
  });
});
