import { Role } from "@prisma/client";
import React, { useEffect, useState } from "react";
import { FieldError } from "react-hook-form";
import styled from "styled-components";

type RadioOwnProps = {
  label?: string;
  error?: FieldError;
  role?: Role;
  value: Role;
  currentlySelected: Role;
};

type RadioProps = RadioOwnProps & React.ComponentPropsWithoutRef<"input">;

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
      role,
      disabled,
      ...rest
    },
    forwardedRef,
  ): React.ReactElement => {
    const [isActive, setIsActive] = useState<boolean>(false);

    useEffect(() => {
      setIsActive(currentlySelected === value);
    }, [currentlySelected, value]);

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
      />
    );

    // The input is visually hidden and driven by the wrapping label, so a
    // disabled option needs to *look* unavailable too - the disabled input
    // already ignores the click, but without this the button looks live and
    // the user is left wondering why nothing happened (SCRUM-289).
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
          {error && (
            <p className="mt-2 text-sm text-red-500">{error.message}</p>
          )}
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
          {error && (
            <p className="mt-2 text-sm text-red-500">{error.message}</p>
          )}
        </StyledInactiveRadioButton>
      );
    }
  },
);

Radio.displayName = "Radio";

export default Radio;
