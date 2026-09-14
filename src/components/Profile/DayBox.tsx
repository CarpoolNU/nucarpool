import React from "react";

/**
 * The interactive day toggle, rendered inside a MUI `Checkbox` by `SelectDays`.
 *
 * **`className` is not decoration here, it is the component's only size
 * escape hatch.** `SelectDays` accepts a `dayBoxClassName` and forwards it as
 * `className` to whichever box it is rendering, and `StaticDayBox` has always
 * accepted it - but this component did not declare the prop, so React dropped
 * it and the sizes a caller asked for silently did nothing. `yarn tsc` did not
 * catch that; see the note at `SelectDays`' `DayBoxComponent` for why it
 * cannot.
 *
 * Defaulted to `""` rather than left `undefined` so an omitted prop
 * interpolates to nothing. `StaticDayBox` has no default and writes the string
 * `"undefined"` into its class list when called without one; that is harmless
 * because it matches no utility, but it is not worth copying.
 */
const DayBox = ({
  day,
  isSelected,
  className = "",
}: {
  day: string;
  isSelected: boolean;
  className?: string;
}): React.ReactElement => {
  const baseClasses =
    "flex h-10 w-10 items-center justify-center rounded-full ml-2 border \
    border-black text-xl sm:h-10 sm:w-10 sm:text-lg md:h-14 md:w-14 md:text-lg \
    lg:h-16 lg:w-16 lg:text-2xl";

  const selectedClasses = isSelected
    ? "bg-northeastern-red text-white"
    : "bg-white text-black";

  return (
    <div className={`${baseClasses} ${selectedClasses} ${className}`}>
      {day}
    </div>
  );
};

export default DayBox;
