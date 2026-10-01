import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { useState } from "react";
import ControlledTimePicker from "./ControlledTimePicker";
import type { OnboardingFormInputs } from "../../utils/types";

/**
 * The time picker survives a parent render.
 *
 * **The defect.** `TimePickerWrapper` was declared inside
 * `ControlledTimePicker`'s body, so it was a new function identity on every
 * render. React compares `element.type` by identity, and a new identity is a
 * *different component* - so the existing tree was unmounted and a fresh antd
 * `TimePicker` mounted in its place on each parent render. The open panel is
 * that picker's own internal state, so it was destroyed by the very render
 * picking an hour caused: the panel closed, focus went with it, and the control
 * could not be used to pick a time.
 *
 * **What is asserted, and why it is the DOM node.** A remount is not observable
 * from the outside as a prop or a class - the markup is identical either way.
 * What changes is node identity: unmounting removes the old element from the
 * document and mounting inserts a new one. So this holds a reference to the
 * input across a parent re-render and requires it to be the same object, and to
 * still be connected. That is the mechanism itself rather than a proxy for it.
 *
 * **This is a structural claim, not a behavioural one.** It does not open the
 * panel, pick an hour or assert on focus: antd's picker renders its panel into
 * a portal driven by real pointer and transition behaviour, and jsdom computes
 * no layout. The ticket's own evidence was structural for the same reason. What
 * this does guarantee is that the cause is gone and cannot come back, which is
 * the part a test can own.
 *
 * Note that StrictMode - on for every component test, per `jest.setup.dom.ts` -
 * does not mask this one the way it masks the sidebar's in-place reversal.
 * StrictMode double-invokes the render *function*; it does not make a new
 * component type reconcile as the old one.
 */

/** Drives the real `Controller` the component is built around. */
const Harness = () => {
  const { control } = useForm<OnboardingFormInputs>({
    defaultValues: { startTime: undefined },
  });
  // A piece of parent state with nothing to do with the picker, so pressing
  // the button reproduces exactly the case that broke it: an unrelated render.
  const [count, setCount] = useState(0);

  return (
    <div>
      <button type="button" onClick={() => setCount(count + 1)}>
        unrelated render {count}
      </button>
      <ControlledTimePicker
        control={control}
        name="startTime"
        id="start-time"
        placeholder="Start time"
      />
    </div>
  );
};

describe("ControlledTimePicker across an unrelated parent render", () => {
  it("keeps the same input element rather than remounting the picker", () => {
    render(<Harness />);

    const before = screen.getByPlaceholderText("Start time");
    expect(before).toBeInTheDocument();

    // `fireEvent` rather than `userEvent`: a plain click is all that is needed
    // to set the parent's state, and the full pointer sequence would add a
    // focus change this test would then have to reason about. A bare
    // `element.click()` is not enough - the state update would land outside
    // `act` and React would not have re-rendered by the time this returns.
    fireEvent.click(screen.getByRole("button", { name: /unrelated render/ }));

    // The parent genuinely re-rendered - without this the identity check below
    // would pass against a button that did nothing.
    expect(
      screen.getByRole("button", { name: "unrelated render 1" }),
    ).toBeInTheDocument();

    const after = screen.getByPlaceholderText("Start time");

    // The assertion. Under the old inline declaration these are two different
    // nodes, because the subtree was torn down and rebuilt.
    expect(after).toBe(before);
    expect(before.isConnected).toBe(true);
  });
});
