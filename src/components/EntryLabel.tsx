import { FieldError } from "react-hook-form";
import styled from "styled-components";

interface EntryLabelProps {
  error?: FieldError | (FieldError | undefined)[];
  label: string;
  required?: boolean;
  className?: string;
}

/*
 * `$error`, not `error`: the `$` marks the prop transient, so styled-components
 * v6 consumes it for the template below and does not forward it to the <label>.
 * Without it React receives `error={true}` as a DOM attribute, declines to
 * write it, and logs "Received `true` for a non-boolean attribute `error`"
 * (SCRUM-425). Same defect SCRUM-424 fixed in `Header`'s `MobileNavItem`;
 * these two were the repository's only typed styled components, and both had
 * it. See CLAUDE.md's conventions section, which now states the rule.
 *
 * Distinct from `EntryLabelProps.error` above, which is this component's own
 * public prop and keeps its name - every caller passes a react-hook-form
 * `FieldError` through it. Only the internal styled prop is renamed.
 */
const StyledLabel = styled.label<{
  $error?: boolean;
}>`
  font-family: "Montserrat", sans-serif;
  font-style: normal;
  font-weight: 700;
  font-size: 20px;
  line-height: 24px;
  display: flex;
  align-items: center;
  color: ${(props) => (props.$error ? "#B12424" : "#000000")};

  @media (min-width: 834px) {
    padding-top: 0.3rem;
    padding-bottom: 0.4rem;
    font-size: 20px;
  }
`;

export const EntryLabel = (props: EntryLabelProps) => {
  return props.required ? (
    <StyledLabel $error={!!props.error} className={props.className}>
      {props.label}
      <span className={"text-northeastern-red pl-1"}>*</span>
    </StyledLabel>
  ) : (
    <StyledLabel className={props.className}>{props.label} </StyledLabel>
  );
};
