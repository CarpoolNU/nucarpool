import { render, screen } from "@testing-library/react";
import { useForm, UseFormReturn } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import StepThree from "./StepThree";
import { OnboardingFormInputs } from "../../utils/types";

/**
 * The co-op month pickers, unmounted and remounted with the same form
 * instance - the shape of `setup.tsx`'s Previous/Next navigation.
 *
 * `setup.tsx` renders each step conditionally (`{step === 3 && <StepThree
 * .../>}`), which unmounts the step rather than hiding it; the `useForm` call
 * lives one level up and survives the toggle. Both pickers had an `onChange`
 * and no `value`, so antd's own state - which is what a mounted `<input>`
 * actually displays - restarted at `null` on every remount while the form
 * went on holding the dates untouched (SCRUM-512). `AccountSection.test.tsx`
 * covers the sibling picker's own version of this same property.
 */
const Harness = ({
  mounted,
  formOut,
}: {
  mounted: boolean;
  /** A plain object rather than a `let` outside, so writing to it from this
   * render does not depend on React re-running the component to be visible
   * to the test that reads it back. */
  formOut: { current: UseFormReturn<OnboardingFormInputs> | null };
}) => {
  const form = useForm<OnboardingFormInputs>({
    defaultValues: {
      role: Role.DRIVER,
      status: Status.ACTIVE,
      coopStartDate: new Date("2026-01-15T00:00:00Z"),
      coopEndDate: new Date("2026-06-15T00:00:00Z"),
    },
  });

  formOut.current = form;

  const {
    watch,
    control,
    setValue,
    formState: { errors },
  } = form;

  if (!mounted) {
    return null;
  }

  return (
    <StepThree
      watch={watch}
      control={control}
      setValue={setValue}
      errors={errors}
    />
  );
};

const monthInput = (container: HTMLElement, id: string) => {
  const input = container.querySelector<HTMLInputElement>(`input#${id}`);

  expect(input).not.toBeNull();

  return input as HTMLInputElement;
};

describe("StepThree co-op date pickers", () => {
  it("displays the months the form was initialised with", () => {
    const formOut = { current: null };
    const { container } = render(<Harness mounted={true} formOut={formOut} />);

    expect(monthInput(container, "coopStartDate").value).toBe("2026-01");
    expect(monthInput(container, "coopEndDate").value).toBe("2026-06");
  });

  /**
   * The defect. Pressing Previous from step 4 and then Next again unmounts
   * and remounts step 3 without touching the form, so both pickers have to
   * keep showing the dates the form still holds - not their placeholder.
   */
  it("still shows the held dates after an unmount and remount", () => {
    const formOut: { current: UseFormReturn<OnboardingFormInputs> | null } = {
      current: null,
    };

    const { container, rerender } = render(
      <Harness mounted={true} formOut={formOut} />,
    );

    expect(monthInput(container, "coopStartDate").value).toBe("2026-01");

    rerender(<Harness mounted={false} formOut={formOut} />);
    rerender(<Harness mounted={true} formOut={formOut} />);

    expect(monthInput(container, "coopStartDate").value).toBe("2026-01");
    expect(monthInput(container, "coopEndDate").value).toBe("2026-06");
    // The form itself was never touched by the remount.
    expect(formOut.current?.getValues("coopStartDate")).toEqual(
      new Date("2026-01-15T00:00:00Z"),
    );
  });

  it("starts empty with no co-op dates and follows a date set later", () => {
    const Empty = ({ mounted }: { mounted: boolean }) => {
      const form = useForm<OnboardingFormInputs>({
        defaultValues: {
          role: Role.DRIVER,
          status: Status.ACTIVE,
          coopStartDate: null,
          coopEndDate: null,
        },
      });

      if (!mounted) {
        return null;
      }

      return (
        <StepThree
          watch={form.watch}
          control={form.control}
          setValue={form.setValue}
          errors={form.formState.errors}
        />
      );
    };

    const { container } = render(<Empty mounted={true} />);

    expect(monthInput(container, "coopStartDate").value).toBe("");
    expect(monthInput(container, "coopEndDate").value).toBe("");
  });
});

/**
 * SCRUM-513. `EntryLabel` had no `htmlFor`, so every field in this step
 * announced as unlabelled to a screen reader despite the visible text beside
 * it - see the ticket for the full inventory. The positive `getByRole` query
 * is the one that actually exercises the label/input association: a
 * `queryByRole(..., { hidden: true })` or similar negative form would pass
 * whether or not the name was ever wired up.
 */
describe("StepThree accessible names", () => {
  it("names the co-op date pickers after their visible labels", () => {
    const formOut = { current: null };
    render(<Harness mounted={true} formOut={formOut} />);

    // The asterisk is inside the `<label>`, so it is part of the computed
    // accessible name alongside the visible text.
    expect(
      screen.getByRole("textbox", { name: "Start Date *" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "End Date *" }),
    ).toBeInTheDocument();
  });
});
