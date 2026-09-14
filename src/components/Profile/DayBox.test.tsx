import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import DayBox from "./DayBox";
import SelectDays from "../Schedule/SelectDays";
import { OnboardingFormInputs } from "../../utils/types";

/**
 * `SelectDays`' size escape hatch actually reaching the box it is aimed at.
 *
 * `SelectDays` takes a `dayBoxClassName` and forwards it as `className` to
 * whichever box it renders. `StaticDayBox` has always accepted that;
 * `DayBox` did not declare the prop at all, so React dropped it and every
 * caller trying to size the *interactive* picker was writing a class name into
 * nothing. `CarpoolSection`'s day row overflowed its column on a phone for
 * exactly that reason.
 *
 * **This is a wiring test, and only a wiring test.** `testing/viewport.ts` is
 * the long version; the short version is that jsdom does no layout and
 * evaluates no media queries, so nothing here can show that seven boxes fit in
 * 311px, and a `max-desktop:` utility is inert in this environment. The
 * container query `CarpoolSection` now passes alongside it is inert for a
 * second reason - jsdom implements no container queries at all, and the
 * element it would be sized against measures zero. Asserting the *class
 * string* arrives is the whole of what is assertable, and it is the half that
 * broke. The fit itself is manual verification at 360px and 375px, and in the
 * 640-649px band the container query exists for.
 *
 * Deliberately not asserted: which sizes `CarpoolSection` passes. That is a
 * styling decision, and a test restating it would fail on every future tweak
 * while proving nothing jsdom can see.
 */

/** A sentinel rather than a real utility, so the assertion cannot pass by
 *  accident off a class the component already carries - and so this file does
 *  not emit CSS. Tailwind v4 scans the whole repository, test files included,
 *  so naming a real utility here would ship it. */
const SENTINEL = "daybox-forwarding-sentinel";

const Harness = ({
  useStaticDayBox,
  dayBoxClassName,
}: {
  useStaticDayBox: boolean;
  dayBoxClassName?: string;
}) => {
  const { control } = useForm<OnboardingFormInputs>({
    defaultValues: { daysWorking: new Array(7).fill(false) },
  });

  return (
    <SelectDays
      control={control}
      useStaticDayBox={useStaticDayBox}
      dayBoxClassName={dayBoxClassName}
    />
  );
};

describe("DayBox", () => {
  it("applies a className it is given", () => {
    render(<DayBox day="M" isSelected={false} className={SENTINEL} />);

    expect(screen.getByText("M")).toHaveClass(SENTINEL);
  });

  it("keeps its own classes when given one", () => {
    render(<DayBox day="M" isSelected={true} className={SENTINEL} />);

    // The size ladder and the selected colour still have to survive the
    // addition, since `className` appends rather than replaces.
    expect(screen.getByText("M")).toHaveClass(
      "rounded-full",
      "bg-northeastern-red",
      SENTINEL,
    );
  });

  it("writes no class at all when given none", () => {
    // The failure this guards is interpolating an absent prop straight into a
    // template, which puts the literal string "undefined" in the class list.
    render(<DayBox day="M" isSelected={false} />);

    expect(screen.getByText("M").className).not.toContain("undefined");
  });
});

describe("SelectDays day-box class forwarding", () => {
  // Both branches, because the point of the prop is that a caller can size the
  // picker without knowing which box it got. A new box that ignores
  // `className` fails here; the type checker cannot catch it - see the note in
  // `SelectDays`.
  it.each([
    ["the interactive DayBox", false],
    ["the read-only StaticDayBox", true],
  ])("reaches %s", (_label, useStaticDayBox) => {
    render(
      <Harness useStaticDayBox={useStaticDayBox} dayBoxClassName={SENTINEL} />,
    );

    for (const day of ["Su", "M", "Tu", "W", "Th", "F", "S"]) {
      expect(screen.getByText(day)).toHaveClass(SENTINEL);
    }
  });
});
