import * as React from "react";
import { FieldError } from "react-hook-form";
import { ErrorDisplay } from "../styles/profile";
import { classNames } from "../utils/classNames";
import { fieldErrorId } from "../utils/formA11y";
import { ReactNode } from "react";

type TextFieldOwnProps = {
  error?: FieldError;
  charLimit?: number;
  inputClassName?: string;
  className?: string;
  isDisabled?: boolean;
};

type TextFieldProps = TextFieldOwnProps &
  React.ComponentPropsWithoutRef<"input">;
const customSuffixIcon = (): ReactNode => {
  return <div className="text-northeastern-red text-xs">▼</div>;
};
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  (
    {
      charLimit = 524288,
      isDisabled,
      id,
      name,
      error,
      type,
      className,
      inputClassName,
      "aria-invalid": ariaInvalidProp,
      "aria-describedby": ariaDescribedbyProp,
      ...rest
    },
    forwardedRef,
  ) => {
    const fieldId = id || name;
    const errorId = error && fieldId ? fieldErrorId(fieldId) : undefined;
    // A caller that renders its own error text outside this component (there
    // is no single canonical location for every call site - see
    // `InitialStep`/`UserSection`'s decoupled seat-availability layout) passes
    // its own `aria-invalid`/`aria-describedby` instead of `error`, so the
    // component doesn't also render a second, duplicate `ErrorDisplay`. Only
    // fall back to those when this component has nothing of its own to say.
    const resolvedAriaInvalid = error ? true : ariaInvalidProp;
    const resolvedAriaDescribedby = errorId ?? ariaDescribedbyProp;
    return (
      <div className={classNames(`flex w-full flex-col space-y-2`, className)}>
        <div className="relative w-full">
          <input
            {...rest}
            ref={forwardedRef}
            id={fieldId}
            name={name}
            type={type}
            disabled={isDisabled}
            maxLength={charLimit}
            aria-invalid={resolvedAriaInvalid}
            aria-describedby={resolvedAriaDescribedby}
            className={classNames(
              `form-input font-montserrat w-full rounded-md px-3 py-2 shadow-xs ${
                isDisabled
                  ? "bg-gray-100 text-gray-400" + " border-gray-200"
                  : ""
              } ${error ? "border-northeastern-red" : "border-black"}`,
              inputClassName,
            )}
          />
          {type === "month" && (
            <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              {customSuffixIcon()}
            </div>
          )}
        </div>
        {error && (
          <ErrorDisplay id={errorId} role="alert">
            {error.message}
          </ErrorDisplay>
        )}
      </div>
    );
  },
);

TextField.displayName = "TextField";
