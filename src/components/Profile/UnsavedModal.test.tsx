/**
 * The first component test in this repository (SCRUM-377).
 *
 * `UnsavedModal` is deliberately the subject: it is three buttons and no
 * dependencies, so anything that fails here is the jsdom project's wiring
 * rather than the component. It is also the dialog behind the profile page's
 * unsaved-changes guard, which SCRUM-381 and SCRUM-384 both change - so the
 * assertions below are the baseline those tickets edit against, not throwaway
 * scaffolding.
 *
 * What this proves, beyond the component: the `jsdom` project picks up a
 * `.tsx` file, ts-jest compiles JSX with the automatic runtime, React 19
 * renders through `@testing-library/react`, `@testing-library/jest-dom`'s
 * matchers are registered, and `user-event` can drive a real click.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UnsavedModal from "./UnsavedModal";

const renderModal = () => {
  const onClose = jest.fn();
  const onSave = jest.fn();
  const onContinue = jest.fn();

  render(
    <UnsavedModal onClose={onClose} onSave={onSave} onContinue={onContinue} />,
  );

  return { onClose, onSave, onContinue };
};

describe("UnsavedModal", () => {
  it("states that there are unsaved changes", () => {
    renderModal();

    expect(screen.getByText("You have unsaved changes!")).toBeInTheDocument();
    expect(
      screen.getByText("Continue with or without saving?"),
    ).toBeInTheDocument();
  });

  it("offers exactly three actions", () => {
    renderModal();

    // Three and no more: a fourth escape route from this dialog is a product
    // change, and the guard's callers assume these are the only exits.
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "Save and Continue" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
  });

  it("calls onSave when Save and Continue is clicked, and nothing else", async () => {
    const { onClose, onSave, onContinue } = renderModal();

    await userEvent.click(
      screen.getByRole("button", { name: "Save and Continue" }),
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onContinue when Continue is clicked, and nothing else", async () => {
    const { onClose, onSave, onContinue } = renderModal();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // The discard path. `onSave` firing here would silently save changes the
    // user asked to abandon, which no assertion could catch by reading.
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the dismiss button is clicked, and nothing else", async () => {
    const { onClose, onSave, onContinue } = renderModal();

    // The × has no accessible label, so it can only be reached positionally.
    // Asserting on that is worth doing: it records the gap rather than hiding
    // it, and the day someone gives the button an `aria-label` this test fails
    // and gets updated to use it.
    const [dismiss] = screen.getAllByRole("button");
    await userEvent.click(dismiss);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("focuses Save and Continue on mount", () => {
    renderModal();

    // `autoFocus` on the save button, so Enter saves rather than discards.
    // Only observable with a DOM.
    expect(
      screen.getByRole("button", { name: "Save and Continue" }),
    ).toHaveFocus();
  });
});
