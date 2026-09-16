import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { useForm, UseFormReturn } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import AccountSection from "./AccountSection";
import { OnboardingFormInputs } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * The two co-op month pickers: the one prop that decides whether tapping one is
 * usable on a phone, and whether what they display follows the form.
 *
 * antd's `DatePicker` renders a real `<input>`. Left focusable, a tap on a
 * touch device opens the soft keyboard *and* the month panel, and the keyboard
 * covers the panel it just opened - so the control is materially harder to use
 * than the identical pickers in `Setup/StepThree`, which pass
 * `inputReadOnly`. Nothing is typed into these fields; a month is only ever
 * chosen from the panel.
 *
 * **`readOnly` is the assertion, not the keyboard.** jsdom has no soft
 * keyboard and no touch, so "no keyboard appears" is not observable here -
 * what is observable is that the input is not a typing target, which is the
 * property the platform keys its behaviour off. Confirming the keyboard stays
 * down needs a real device.
 *
 * The displayed month, by contrast, *is* fully observable in jsdom: it is the
 * `value` of an input, not geometry. These pickers were passed `defaultValue`,
 * which antd reads once at mount and ignores afterwards, so `reset(...)` moved
 * the form and left the control behind. `src/pages/profile/index.tsx` resets on
 * every `user` change - which every save triggers, via a refetch - while
 * `AccountSection` stays mounted, because it is gated on `option === "account"`
 * at a fixed position in the tree with no `key`. That is the path these tests
 * stand in for.
 */

/**
 * `AccountSection` takes react-hook-form's `control`, `watch`, `setValue` and
 * `errors` as props rather than reading a context, so a real `useForm` is the
 * cheapest honest harness - mocking the shape would assert against the mock.
 *
 * `role` has to be a non-`VIEWER` value: the pickers are rendered `disabled`
 * for a viewer, and a disabled antd input is read-only for an unrelated
 * reason, which would make the test pass with the fix reverted.
 *
 * `onForm` hands the form back so a test can drive `reset(...)` the way the
 * profile page does. The harness itself never remounts `AccountSection` across
 * that call, which is the whole point - a remount would reread `defaultValue`
 * and hide the defect.
 */
const Harness = ({
  initial,
  onForm,
}: {
  initial?: Partial<OnboardingFormInputs>;
  onForm?: (form: UseFormReturn<OnboardingFormInputs>) => void;
}) => {
  const form = useForm<OnboardingFormInputs>({
    defaultValues: {
      role: Role.DRIVER,
      status: Status.ACTIVE,
      coopStartDate: new Date("2026-01-15T00:00:00Z"),
      coopEndDate: new Date("2026-06-15T00:00:00Z"),
      ...initial,
    },
  });

  const { control, watch, setValue, handleSubmit, formState } = form;

  useEffect(() => {
    onForm?.(form);
  }, [form, onForm]);

  return (
    <AccountSection
      control={control}
      watch={watch}
      setValue={setValue}
      errors={formState.errors}
      onSubmit={handleSubmit(() => undefined)}
    />
  );
};

const monthInput = (container: HTMLElement, id: string) => {
  const input = container.querySelector<HTMLInputElement>(`input#${id}`);

  expect(input).not.toBeNull();

  return input as HTMLInputElement;
};

describe("AccountSection co-op date pickers", () => {
  it.each([
    ["start", "coopStartDate"],
    ["end", "coopEndDate"],
  ])("renders the %s date picker read-only", (_label, id) => {
    const { container } = render(<Harness />);

    const input = monthInput(container, id);

    // Asserted on the property as well as the attribute: antd sets
    // `readOnly` through React, and the two can disagree if it is ever passed
    // as a string.
    expect(input).toHaveAttribute("readonly");
    expect(input.readOnly).toBe(true);
    // The picker must still be reachable - `inputReadOnly` must not have been
    // confused with `disabled`, which would stop the panel opening at all.
    expect(input.disabled).toBe(false);
  });

  it("displays the months the form was initialised with", () => {
    const { container } = render(<Harness />);

    expect(monthInput(container, "coopStartDate").value).toBe("2026-01");
    expect(monthInput(container, "coopEndDate").value).toBe("2026-06");
  });

  /**
   * The defect. A save refetches `user.me`, the page's effect calls
   * `reset(...)` with what was stored, and both pickers have to follow. With
   * `defaultValue` they kept displaying the months they mounted with, telling
   * the user their change had not taken - the opposite of the truth, since the
   * write itself was correct.
   */
  it("follows reset() after a save, on both pickers", () => {
    let form: UseFormReturn<OnboardingFormInputs> | null = null;

    const { container } = render(
      <Harness
        onForm={(f) => {
          form = f;
        }}
      />,
    );

    expect(monthInput(container, "coopStartDate").value).toBe("2026-01");

    act(() => {
      // The shape the profile page resets with, and the dates as the columns
      // store them: the last day of the month chosen, at midnight UTC.
      form?.reset({
        role: Role.DRIVER,
        status: Status.ACTIVE,
        coopStartDate: new Date("2026-03-31T00:00:00Z"),
        coopEndDate: new Date("2026-08-31T00:00:00Z"),
      });
    });

    expect(monthInput(container, "coopStartDate").value).toBe("2026-03");
    expect(monthInput(container, "coopEndDate").value).toBe("2026-08");
  });

  /**
   * `UnsavedModal`'s discard path is the same `reset(...)`, back to the values
   * the form was baselined with rather than on to new ones.
   */
  it("restores the displayed months when changes are discarded", () => {
    let form: UseFormReturn<OnboardingFormInputs> | null = null;

    const { container } = render(
      <Harness
        onForm={(f) => {
          form = f;
        }}
      />,
    );

    act(() => {
      form?.setValue("coopStartDate", new Date("2026-04-30T00:00:00Z"));
    });

    expect(monthInput(container, "coopStartDate").value).toBe("2026-04");

    act(() => {
      form?.reset({
        role: Role.DRIVER,
        status: Status.ACTIVE,
        coopStartDate: new Date("2026-01-31T00:00:00Z"),
        coopEndDate: new Date("2026-06-30T00:00:00Z"),
      });
    });

    expect(monthInput(container, "coopStartDate").value).toBe("2026-01");
    expect(monthInput(container, "coopEndDate").value).toBe("2026-06");
  });

  /**
   * A profile with no co-op dates, which is every `VIEWER` who later picks a
   * role. Two failure modes are guarded here, and the second is the reason this
   * fix does not simply spread `value` unconditionally:
   *
   * - the picker must start empty. `formatDateToMonth(null)` is `undefined`,
   *   and `dayjs(undefined, fmt)` is `Invalid Date` once `customParseFormat` is
   *   extended - which antd's own picker does to the shared dayjs singleton -
   *   and **today** when it is not. Neither reads as "no month chosen", so the
   *   empty case never reaches `dayjs` at all.
   * - gaining a date later has to reach the display. Under the old conditional
   *   spread the prop was absent at mount, so it stayed blank for good.
   */
  it("starts empty with no co-op dates and follows a date set later", () => {
    let form: UseFormReturn<OnboardingFormInputs> | null = null;

    const { container } = render(
      <Harness
        initial={{ coopStartDate: null, coopEndDate: null }}
        onForm={(f) => {
          form = f;
        }}
      />,
    );

    expect(monthInput(container, "coopStartDate").value).toBe("");
    expect(monthInput(container, "coopEndDate").value).toBe("");

    act(() => {
      form?.setValue("coopStartDate", new Date("2026-02-28T00:00:00Z"));
    });

    expect(monthInput(container, "coopStartDate").value).toBe("2026-02");
    expect(monthInput(container, "coopEndDate").value).toBe("");
  });
});

/**
 * The widths this section asks for, either side of the mobile breakpoint.
 *
 * **Class-request assertions, and that is the ceiling in this file.**
 * SCRUM-490 is a geometry defect - a declared 700px box hanging 315px off a
 * 667px screen, inside a column that hides the overflow rather than scrolling
 * it - and jsdom resolves no CSS and reports every rect as zero, so none of
 * that is observable here. See `src/testing/viewport.ts`. What *is* observable
 * is which utilities the component asks for, and the defect was precisely the
 * absence of a cap beside the declared width. So these fail if the cap is
 * dropped again, and they would still pass if a cap were present and
 * ineffective - which is the honest limit of the assertion. The pixels are in
 * `src/testing/layoutFixtures.ts`'s `profile-content-column-width`, measured in
 * Chromium; the geometry itself belongs in SCRUM-264's Playwright suite.
 */
describe("AccountSection widths", () => {
  restoreViewportAfterEach();

  /* The outermost div carries the width. Reached by position rather than by a
     class, so the assertions are about what that element requests and not
     about a selector that has already assumed the answer. */
  const section = (container: HTMLElement) =>
    container.firstElementChild as HTMLElement;

  /* The date row found through one of the pickers it contains, rather than by
     its own classes - those are the thing under test, and a selector naming
     them could not observe them changing. */
  const dateRow = (container: HTMLElement) => {
    const column = monthInput(container, "coopStartDate").closest(".flex-1");

    expect(column).not.toBeNull();

    const row = column?.parentElement;

    expect(row).not.toBeNull();

    return row as HTMLElement;
  };

  it("caps its declared desktop width against the container", () => {
    setViewportWidth(DESKTOP_WIDTH);

    const { container } = render(<Harness />);

    /* Both halves matter. The declared width is the design intent and is
       kept; the cap is what stops it being a floor. Asserting only the cap
       would pass if someone deleted the design width, and asserting only the
       width is the state this ticket found. */
    expect(section(container)).toHaveClass("w-[700px]");
    expect(section(container)).toHaveClass("max-w-full");
  });

  it("asks for the container's width on mobile, where no cap is needed", () => {
    setViewportWidth(MOBILE_WIDTH);

    const { container } = render(<Harness />);

    expect(section(container)).toHaveClass("w-full");
    expect(section(container)).not.toHaveClass("w-[700px]");
  });

  it("gives the date row the whole width rather than a fraction of it", () => {
    setViewportWidth(DESKTOP_WIDTH);

    const { container } = render(<Harness />);

    /* The fraction is the regression to catch. Two thirds of the capped
       column left each picker 96.66px in Chromium, at which both labels wrap
       onto a second line - so a fraction here is not a cosmetic preference,
       it is what made the row worse once the cap was added. */
    expect(dateRow(container)).toHaveClass("w-full");
    expect(dateRow(container).className).not.toMatch(/\bw-\d+\/\d+/);
  });

  it("stacks the date row on mobile instead of sizing it", () => {
    setViewportWidth(MOBILE_WIDTH);

    const { container } = render(<Harness />);

    expect(dateRow(container)).toHaveClass("flex-col");
  });
});
