/**
 * The first component test in this repository.
 *
 * `UnsavedModal` is deliberately the subject: it is three buttons and no
 * dependencies, so anything that fails here is the jsdom project's wiring
 * rather than the component. It is also the dialog behind the profile page's
 * unsaved-changes guard, which later work changes - so the
 * assertions below are the baseline that work edits against, not throwaway
 * scaffolding.
 *
 * What this proves, beyond the component: the `jsdom` project picks up a
 * `.tsx` file, ts-jest compiles JSX with the automatic runtime, React 19
 * renders through `@testing-library/react`, `@testing-library/jest-dom`'s
 * matchers are registered, and `user-event` can drive a real click.
 */

import { act, render, screen } from "@testing-library/react";
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

    // The × glyph is not itself an accessible name - `aria-label="Close"` is
    // what makes this findable by role and name rather than by position.
    // SCRUM-514.
    const dismiss = screen.getByRole("button", { name: "Close" });
    await userEvent.click(dismiss);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  /**
   * SCRUM-514: the modal used to be a plain `div` with no `role`, so a
   * screen-reader user got no indication one had opened at all.
   */
  it("exposes itself as a modal dialog", () => {
    renderModal();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape, with the same effect as the dismiss button", async () => {
    const { onClose, onSave, onContinue } = renderModal();

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("returns focus to the control that opened it once it closes", async () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.appendChild(opener);
    opener.focus();
    expect(opener).toHaveFocus();

    const { unmount } = render(
      <UnsavedModal
        onClose={jest.fn()}
        onSave={jest.fn()}
        onContinue={jest.fn()}
      />,
    );
    expect(opener).not.toHaveFocus();

    // The parent only ever renders this component while `showModal` is true,
    // so closing is an unmount - not a prop flip - and Headless UI's own
    // restore-focus effect runs after that, asynchronously.
    await act(async () => {
      unmount();
    });

    expect(opener).toHaveFocus();
    document.body.removeChild(opener);
  });

  it("focuses Save and Continue on mount", () => {
    renderModal();

    // `autoFocus` on the save button, so Enter saves rather than discards.
    // Only observable with a DOM.
    expect(
      screen.getByRole("button", { name: "Save and Continue" }),
    ).toHaveFocus();
  });

  /**
   * A class request, and nothing more than that.
   *
   * **jsdom resolves no CSS and reports every rect as zero** (`src/testing/
   * viewport.ts`), so this cannot show that the panel fits a viewport, that a
   * label stops wrapping, or that `min()` resolves the way CSS says it does.
   * All three were measured in Chromium against the compiled stylesheet
   * through the `centred-dialog-panels` fixture, and the figures live in that
   * fixture's `recorded` list.
   *
   * What this does catch is the one regression a reader is most likely to
   * cause: deleting the floor as redundant next to `w-1/3`, or "simplifying"
   * it to an unconditional 22rem, either of which restores a symmetric
   * unreachable overflow that no test in `yarn test` can see. The fixture's
   * drift guard catches the same edit from the other direction - it fails when
   * the class string here no longer matches the one the fixture reproduces -
   * so this assertion is the half that still holds if the fixture is ever
   * retired.
   */
  it("floors the panel width without letting the floor exceed the space available", () => {
    renderModal();

    const panel = screen.getByText("You have unsaved changes!").parentElement;

    expect(panel).toHaveClass("w-1/3");
    expect(panel).toHaveClass("min-w-[min(22rem,100%)]");
  });
});
