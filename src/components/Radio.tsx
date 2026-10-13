import { Role } from "@prisma/client";
import React, { useEffect, useState } from "react";
import { FieldError } from "react-hook-form";
import styled, { css } from "styled-components";
import { DESKTOP_MEDIA_QUERY } from "../utils/breakpoints";
import { fieldErrorId } from "../utils/formA11y";

type RadioOwnProps = {
  label?: string;
  error?: FieldError;
  value: Role;
  currentlySelected: Role;
};

type RadioProps = RadioOwnProps &
  Omit<React.ComponentPropsWithoutRef<"input">, "role">;

/**
 * The focus indicator, shared by both arms below.
 *
 * The input is visually hidden (see `className` on it), so it has no box of
 * its own for the browser's default ring to be drawn around - without this,
 * the control would be reachable by keyboard and give no visible sign of it.
 * `:has()` keys the ring off the hidden input's state and draws it on the
 * label the user can actually see.
 *
 * `:focus-visible` rather than `:focus`, so a pointer click does not paint a
 * ring; and black rather than this repo's usual red, because the selected arm's
 * background is that same red and the ring has to show on both.
 *
 * One fragment rather than a copy per arm: the two labels differ only in
 * colour, and a focus ring that drifted between them would be a defect nobody
 * would think to look for.
 */
const focusRing = css`
  &:has(input:focus-visible) {
    outline: 2px solid #000;
    outline-offset: 2px;
  }
`;

/**
 * Everything the two arms below share, which is everything except colour.
 *
 * One fragment rather than a copy per arm, for the reason `focusRing` gives:
 * the arms differ only in how they are painted, and a *measurement* that
 * drifted between them would put the selected role on a different grid from
 * the other two - the hardest kind of layout defect to see, because whichever
 * one is wrong is also the one the eye is drawn to.
 *
 * `padding` and `font-size` are stated here rather than left to the
 * `form-input` class the label also carries. The declarations below win
 * because styled-components injects them unlayered and `form-input` compiles
 * into `@layer utilities` - the same mechanism that already lets
 * `border-radius: 10px` beat that class's `border-radius: 0`. That is a
 * property of the cascade rather than of injection order, so it does not
 * depend on which stylesheet reaches the document first.
 */
const radioButtonBase = css`
  font-family: "Montserrat";
  font-style: normal;
  font-weight: 500;
  border-radius: 10px;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;

  /*
   * The mobile values, and they are the base rather than an override because
   * DESKTOP_MEDIA_QUERY is a min-width - see breakpoints.js for why that
   * direction is the one that agrees with useIsMobile at the boundary pixel.
   *
   * 18px because 24px does not fit. The three buttons divide the profile
   * page's content column between them, so at a 320px viewport each is 80px
   * wide, and "Viewer" - the longest of the three labels - needs 81.91px at
   * 24px in Montserrat before any padding at all. At 18px it needs 61.44px,
   * which clears the 70px those 80 leave once this padding and the 1px border
   * are taken off. 18px is also the size the seat-availability field beside
   * this row already uses.
   *
   * The 4px of horizontal padding is deliberately far below form-input's 12px,
   * and costs nothing visible: the label is a centred flex container, so
   * horizontal padding is invisible until the text is within 4px of filling the
   * box - which is to say, it is only ever noticed in the state this fixes.
   * Keeping 12px here would take 24px off every 80px box and force the label
   * down to 15px to fit, which is a worse answer to the same question.
   */
  font-size: 18px;
  padding-left: 4px;
  padding-right: 4px;

  @media ${DESKTOP_MEDIA_QUERY} {
    font-size: 24px;
    padding-left: 12px;
    padding-right: 12px;
  }

  ${focusRing}
`;

const StyledActiveRadioButton = styled.label`
  background-color: #c8102e;
  color: white;

  ${radioButtonBase}
`;

const StyledInactiveRadioButton = styled.label`
  background-color: white;
  color: black;
  border: 1px solid black;

  ${radioButtonBase}
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
        // *name* the instant an error renders.
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

    /*
     * The button's width, and the reason there is no width utility here at all.
     *
     * This used to carry a utility fixing each button at a quarter of the row,
     * at every viewport - spelled out as a number rather than as that class
     * name, because Tailwind scans this comment and naming it here would ship
     * a rule nothing uses. It **has never had any effect on desktop**, which is
     * why that arm is left without a replacement. The row is a flex item sized
     * by its contents, so its width is indefinite while its children are laid
     * out, and a percentage width against an indefinite containing block
     * resolves to `auto`. Measured in Chromium against this repository's
     * compiled stylesheet, the desktop buttons are 107.91 / 90.23 / 98.50px -
     * each one its own label's width plus padding and border, not the 90.16px
     * a resolved quarter of the 360.65px row would give. `desktop:flex-initial`
     * restores the flex default, so that arm renders exactly as it does today.
     *
     * Two details worth keeping, because both cost a measurement to find.
     * Moving that same declaration behind a media query makes it *start*
     * resolving - wrapped in `@media`, Chromium resolves the quarter and the
     * buttons become an equal 90.16px, which leaves the 24px "Viewer" just
     * 4.12px inside its border. So the inert rule could not simply be given a
     * `desktop:` prefix and kept. And the row being content-sized is also why
     * the desktop arm never had this defect: a content-sized box cannot be too
     * narrow for its own content.
     *
     * On mobile the row *is* definite - it is a block filling the content
     * column - and a fixed quarter of it is the defect: three quarters plus
     * the row's two gaps do not fill the row, so every button is narrower than
     * it could be *and* the row ends in unused space. `flex-1` divides the row
     * between the three instead, which both widens each button and removes
     * that dead space. The three stay exactly equal because the basis is 0;
     * anything content-sized would size them to their labels, which differ.
     */
    const sizeClass = "h-14 flex-1 desktop:flex-initial";

    /* Appended rather than ignored. This component took a `className` and
       dropped it on the floor, which is worse than not accepting one: the
       obvious way to adjust a button from the call site compiled, rendered and
       did nothing. */
    const labelClass =
      `form-input ${sizeClass} ${stateClass} ${className ?? ""}`.trim();

    if (isActive) {
      return (
        <StyledActiveRadioButton className={labelClass} htmlFor={id}>
          {input}
          {label}
          {errorMessage}
        </StyledActiveRadioButton>
      );
    } else {
      return (
        <StyledInactiveRadioButton className={labelClass} htmlFor={id}>
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
