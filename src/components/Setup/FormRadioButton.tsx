import React from "react";
import { FieldError } from "react-hook-form";
import { fieldErrorId } from "../../utils/formA11y";

type RadioProps<T extends string | number> = {
  label: string;
  value: T;
  id: string;
  currentlySelected: T;
  error?: FieldError;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"input">, "role">;

const RadioButton = React.forwardRef<
  HTMLInputElement,
  RadioProps<string | number>
>(
  (
    { label, id, value, currentlySelected, error, className, ...rest },
    forwardedRef,
  ) => {
    const errorId = error ? fieldErrorId(id) : undefined;
    return (
      <label
        htmlFor={id}
        className={`font-montserrat flex cursor-pointer items-center justify-center rounded-lg border border-black px-6 py-2 text-2xl transition ${
          currentlySelected === value
            ? "bg-northeastern-red text-white"
            : "bg-white text-black"
        } ${className}`}
      >
        <input
          type="radio"
          id={id}
          name="role"
          value={value}
          checked={currentlySelected === value}
          className="hidden"
          ref={forwardedRef}
          // Explicit, rather than left to "name from content" on the
          // wrapping `<label>`: the error paragraph below is also inside
          // that label, and content-based naming would fold its text into
          // the accessible *name* the instant an error renders - "Driver
          // Please select a role." - which is exactly the name/description
          // split this ticket exists to keep apart.
          aria-label={label}
          // Not `aria-invalid`: the ARIA spec doesn't support it on `radio` -
          // a radio has no notion of "invalid" input, only unselected. The
          // description is still valid and still what a screen reader needs
          // to hear why the group is red.
          aria-describedby={errorId}
          {...rest}
        />
        {label}
        {error && (
          <p id={errorId} role="alert" className="mt-2 text-sm text-red-500">
            {error.message}
          </p>
        )}
      </label>
    );
  },
);

RadioButton.displayName = "RadioButton";
export default RadioButton;
