import { Role } from "@prisma/client";
import React, { useEffect, useState } from "react";
import { FieldError } from "react-hook-form";
import styled from "styled-components";
import { fieldErrorId } from "../utils/formA11y";

type RadioOwnProps = {
  label?: string;
  error?: FieldError;
  value: Role;
  currentlySelected: Role;
};

type RadioProps = RadioOwnProps &
  Omit<React.ComponentPropsWithoutRef<"input">, "role">;

const StyledActiveRadioButton = styled.label`
  background-color: #c8102e;
  color: white;

  font-family: "Montserrat";
  font-style: normal;
  font-weight: 500;
  font-size: 24px;
  border-radius: 10px;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const StyledInactiveRadioButton = styled.label`
  background-color: white;
  color: black;
  border: 1px solid black;

  font-family: "Montserrat";
  font-style: normal;
  font-weight: 500;
  font-size: 24px;
  border-radius: 10px;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const Radio = React.forwardRef<HTMLInputElement, RadioProps>(
  (
    {
      label,
      id,
      name,
      value,
      error,
      currentlySelected,
      className,
      disabled,
      ...rest
    },
    forwardedRef,
  ): React.ReactElement => {
    const [isActive, setIsActive] = useState<boolean>(false);

    useEffect(() => {
      setIsActive(currentlySelected === value);
    }, [currentlySelected, value]);

    const errorId = error && id ? fieldErrorId(id) : undefined;

    const input = (
      <input
        {...rest}
        ref={forwardedRef}
        id={id}
        name={name}
        type="radio"
        value={value}
        disabled={disabled}
        className={"fixed opacity-0"}
        // Explicit, rather than left to "name from content" on the wrapping
        // `<label>`: the error paragraph is also inside that label, so
        // content-based naming would fold its text into the accessible
        // *name* the instant an error renders (SCRUM-593 / SCRUM-596).
        aria-label={label}
        // Not `aria-invalid`: the ARIA spec doesn't support it on `radio`.
        aria-describedby={errorId}
      />
    );

    const errorMessage = error && (
      <p id={errorId} role="alert" className="mt-2 text-sm text-red-500">
        {error.message}
      </p>
    );

    // The input is visually hidden and driven by the wrapping label, so a
    // disabled option needs to *look* unavailable too - the disabled input
    // already ignores the click, but without this the button looks live and
    // the user is left wondering why nothing happened.
    const stateClass = disabled
      ? "cursor-not-allowed opacity-50"
      : "cursor-pointer";

    if (isActive) {
      return (
        <StyledActiveRadioButton
          className={`form-input h-14 w-3/12 ${stateClass}`}
          htmlFor={id}
        >
          {input}
          {label}
          {errorMessage}
        </StyledActiveRadioButton>
      );
    } else {
      return (
        <StyledInactiveRadioButton
          className={`form-input h-14 w-3/12 ${stateClass}`}
          htmlFor={id}
        >
          {input}
          {label}
          {errorMessage}
        </StyledInactiveRadioButton>
      );
    }
  },
);

Radio.displayName = "Radio";

export default Radio;
