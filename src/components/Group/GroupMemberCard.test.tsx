/**
 * The two-step confirmation in front of Delete Group, Leave Group and Remove.
 *
 * `GroupMemberCard` is rendered directly rather than through `GroupPage`, and
 * that is the point rather than a shortcut: the card takes `actionLabel` and
 * `onAction` as props, so a `jest.fn()` here observes the handler the real
 * call sites wire to `handleDeleteGroup` and `handleRemoveRider` without a
 * trpc client, a group fixture or a mutation mock in between.
 * `GroupPage.test.tsx` renders a user with no `carpoolId` at all and therefore
 * draws no member rows; `GroupPage.driverless.test.tsx` owns the question of
 * *which* actions each group state offers. This file owns what happens once
 * one of them is pressed.
 *
 * **What these assertions are and are not.** SCRUM-476 is a geometry defect:
 * Confirm and Cancel were 36px tall, 8px apart, and Confirm sat in territory
 * the trigger had just occupied. jsdom does no layout and resolves no
 * Tailwind - `getBoundingClientRect()` is all zeros here, see
 * `testing/viewport.ts` - so height, spacing and "which button is under that
 * point" are **not assertable in this file**. The 44px, the 24px and the
 * absence of overlap were measured in Chromium at 375px against the project's
 * compiled stylesheet, and the numbers are recorded in the component's own
 * comment.
 *
 * What is assertable, and what is therefore asserted: the handler is not
 * reached on the first press, Cancel comes before Confirm in tree order, and
 * a second press on the control that now occupies the first slot cancels
 * instead of acting. That last one is the defect itself, minus the pixels -
 * the ordering is a DOM fact even where the position is not.
 *
 * The classes are asserted too, as a deliberate proxy for the measurements
 * above. An assertion on a class name is not an assertion about pixels; it
 * only fails loudly if someone reverts the padding or the gap without reading
 * why they are there.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role } from "@prisma/client";
import { GroupMemberCard } from "./GroupMemberCard";
import { PublicUser } from "../../utils/types";

/**
 * A member row as `groups.me` returns one. Cast rather than filled in: the
 * card reads `preferredName`, `email` and `role` and nothing else.
 */
const MEMBER = {
  id: "alex",
  preferredName: "Alex",
  email: "alex@northeastern.edu",
  role: Role.RIDER,
  carpoolId: "group-1",
} as unknown as PublicUser;

const renderCard = (onAction: () => void, actionLabel = "Remove") =>
  render(
    <GroupMemberCard
      user={MEMBER}
      isCurrentUser={false}
      actionLabel={actionLabel}
      onAction={onAction}
      confirmPrompt="Remove Alex from the group?"
    />,
  );

describe("the destructive confirmation on a group member row", () => {
  it("does not reach the handler on the first press", async () => {
    const onAction = jest.fn();
    renderCard(onAction);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText("Remove Alex from the group?")).toBeInTheDocument();
  });

  it("reaches the handler on the second press, when that press is Confirm", async () => {
    const onAction = jest.fn();
    renderCard(onAction);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  /*
   * The ordering half of SCRUM-476. The trigger is right-aligned in a
   * shrink-wrapped slot and the pair is stacked under `items-end`, so the
   * control in the *first* slot is the one a repeat press in the same place
   * lands on. Cancel has to be that control.
   *
   * Asserted as tree order because that is what jsdom can see. The Chromium
   * measurement behind it - that Confirm ends up with zero overlap of the
   * trigger's footprint at every one of the three labels - is in the
   * component's comment and cannot be reproduced here.
   */
  it("puts Cancel before Confirm in tree order", async () => {
    renderCard(jest.fn());

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent);

    expect(labels).toEqual(["Cancel", "Confirm"]);
  });

  /*
   * The defect, stated without geometry: press the trigger, then press
   * whatever now sits in the slot the trigger occupied. Before SCRUM-476 that
   * second press could be Confirm and the group was gone.
   */
  it("cancels rather than acts when the second press lands on the first control", async () => {
    const onAction = jest.fn();
    renderCard(onAction, "Delete Group");

    await userEvent.click(screen.getByRole("button", { name: "Delete Group" }));
    await userEvent.click(screen.getAllByRole("button")[0]);

    expect(onAction).not.toHaveBeenCalled();
    // Back to the trigger, so the two-step is still reachable rather than
    // merely unpressed.
    expect(
      screen.getByRole("button", { name: "Delete Group" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Remove Alex from the group?"),
    ).not.toBeInTheDocument();
  });

  it("returns to the trigger when Cancel is pressed, without acting", async () => {
    const onAction = jest.fn();
    renderCard(onAction);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("offers no action at all when the call site withholds one", () => {
    render(
      <GroupMemberCard
        user={MEMBER}
        isCurrentUser={false}
        confirmPrompt="Remove Alex from the group?"
      />,
    );

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("refuses Confirm while a mutation is in flight", async () => {
    const onAction = jest.fn();
    render(
      <GroupMemberCard
        user={MEMBER}
        isCurrentUser={false}
        actionLabel="Remove"
        onAction={onAction}
        confirmPrompt="Remove Alex from the group?"
        disabled
      />,
    );

    // The trigger is disabled too, so the confirming state is reached by the
    // only route a user has - and cannot be, which is the intended behaviour.
    const trigger = screen.getByRole("button", { name: "Remove" });
    expect(trigger).toBeDisabled();

    await userEvent.click(trigger);

    expect(onAction).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Confirm" }),
    ).not.toBeInTheDocument();
  });

  /*
   * A proxy for the Chromium measurements, and only a proxy. `p-3` is the
   * 44px - 12 + 20 + 12 - and `gap-6` the 24px; the column is what keeps
   * Confirm clear of the trigger's footprint. None of those three facts is
   * observable in jsdom, so this asserts the inputs to them instead, and
   * fails if someone shrinks the padding or re-flattens the pair into a row
   * without reading the comment that explains why they are not.
   */
  it("keeps the classes the 44px and 24px measurements depend on", async () => {
    renderCard(jest.fn());

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Confirm" });

    expect(cancel).toHaveClass("p-3", "text-sm");
    expect(confirm).toHaveClass("p-3", "text-sm");

    const pair = cancel.parentElement;
    expect(pair).toHaveClass("flex", "flex-col", "gap-6");
    expect(confirm.parentElement).toBe(pair);
  });
});
