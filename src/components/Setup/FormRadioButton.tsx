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
        // The focus ring lives here rather than on the input, because the input
        // is visually hidden and has no box a ring could be drawn around. The
        // `has-[...]` variant keys it off the hidden input's own state, so the
        // styled button that stands in for it shows the focus the keyboard user
        // actually has. Black on both arms: the selected arm's background is
        // the same red as the repo's usual focus colour, which would make a red
        // ring invisible exactly where selection matters most.
        className={`font-montserrat flex cursor-pointer items-center justify-center rounded-lg border border-black px-6 py-2 text-2xl transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-black ${
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
          // Visually hidden, NOT `display: none`. The class this replaced
          // compiled to `display: none`, which takes the input out of the tab
          // order and out of the accessibility tree together - so the
          // `aria-label` below was never exposed and a keyboard-only user
          // could not select a role at all, the first thing onboarding asks
          // for. The clipped 1px box keeps the input focusable and announced
          // while the wrapping label remains the only thing on screen.
          //
          // jsdom cannot see this difference: it loads no stylesheet, so
          // `getByRole("radio")` found these controls even while they were
          // `display: none` in every real browser. The tab order is verified
          // in Chromium against the compiled stylesheet instead.
          className="sr-only"
          ref={forwardedRef}
          // Explicit, rather than left to "name from content" on the
          // wrapping `<label>`: the error paragraph below is also inside
          // that label, and content-based naming would fold its text into
          // the accessible *name* the instant an error renders - "Driver
          // Please select a role." - which is exactly the name/description
          // split that has to stay apart.
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
