import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestStatus, Role, Status } from "@prisma/client";
import MessageHeader from "./MessageHeader";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * Which request controls the conversation header renders, at each viewport.
 *
 * **This file is the ticket.** Accept, Reject and Withdraw Request existed
 * exactly once each in the whole of `src/`, all four occurrences below an
 * `if (ismobile)` early return that rendered a back arrow and a name and
 * nothing else. So on a phone a received request could be read and replied to
 * but not answered, and a sent one could not be taken back — and because a
 * `PENDING` request makes `requests.create` refuse with `CONFLICT`, a
 * mobile-only user could not clear it and start again either. The rule module
 * that decides which controls apply was computed on mobile and then discarded.
 *
 * `messageHeaderControls` was already tested as a table, and it was right the
 * whole time: the defect was that one of its two readers never rendered
 * anything from it. That is the shape of bug a table test cannot see, which is
 * why the assertions here are about the rendered tree and are made at both
 * widths.
 *
 * The desktop cases are not redundant. The fix shares one control component
 * between the two branches, so the failure mode it introduces is a control
 * rendered *twice* on desktop, or the outlined button silently swapping label
 * between Reject and Withdraw. Both are asserted as exact sets of accessible
 * names, because a presence check passes against either.
 *
 * *What this does not cover:* nothing here asserts geometry or that the new
 * row fits on a 375px screen alongside the tab strip, message list and send
 * bar. jsdom does no layout — see `testing/viewport.ts` for the measured list
 * of what it cannot tell you. These tests assert reachability and wiring.
 */

/**
 * The desktop branch resolves an avatar through a presigned-URL query. The
 * subject here is which controls exist, so the hook is stubbed as a shape
 * rather than driven through a tRPC provider — the precedent is
 * `ConnectCard.test.tsx`.
 */
jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    isLoading: false,
  }),
}));

restoreViewportAfterEach();

/** The mobile header's own control, and the baseline every mobile set starts with. */
const BACK = "Back to conversations";
/** The desktop header's own control. It is a bare `×` carrying an aria-label. */
const CLOSE = "Close";

const PENDING = { id: "req-1", status: RequestStatus.PENDING } as const;

const OTHER_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  pronouns: "they/them",
  bio: "",
  image: null,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  carpoolId: null,
  isFavorited: false,
};

/** A RIDER reader, so a DRIVER counterpart still fits and Accept is offered. */
const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  carpoolId: null,
} as unknown as User;

const otherUser = (over: Record<string, unknown> = {}) =>
  ({ ...OTHER_USER, ...over }) as unknown as EnhancedPublicUser;

/**
 * Every accessible name in the header, in tree order.
 *
 * The close and back controls have no text of their own, so the name has to
 * come from `aria-label` where there is one. Asserted as a whole list rather
 * than probed one control at a time: a duplicated Accept and a control that
 * should not be there are both invisible to a presence check.
 */
const buttonNames = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);

type HeaderOverrides = {
  selectedUser?: EnhancedPublicUser;
  viewer?: User;
  groupId?: string | null;
  isMutating?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  onClose?: () => void;
};

/**
 * Split out from `renderHeader` so a test can `rerender` the same tree with a
 * different counterpart - the conversation switch that must not carry a
 * half-answered confirmation with it.
 */
const headerElement = (over: HeaderOverrides = {}) => (
  <UserContext.Provider value={over.viewer ?? VIEWER}>
    <MessageHeader
      selectedUser={over.selectedUser ?? otherUser()}
      onAccept={over.onAccept ?? (() => undefined)}
      onReject={over.onReject ?? (() => undefined)}
      onClose={over.onClose ?? (() => undefined)}
      groupId={over.groupId ?? null}
      isMutating={over.isMutating ?? false}
    />
  </UserContext.Provider>
);

const renderHeader = (over: HeaderOverrides = {}) =>
  render(headerElement(over));

describe("Conversation header controls on mobile", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("offers Reject and Accept for a pending incoming request", () => {
    renderHeader({ selectedUser: otherUser({ incomingRequest: PENDING }) });

    expect(buttonNames()).toEqual([BACK, "Reject", "Accept"]);
  });

  it("offers Withdraw Request for a pending outgoing request", () => {
    renderHeader({ selectedUser: otherUser({ outgoingRequest: PENDING }) });

    // And no Accept: accepting your own request is not a thing, and the
    // outlined button is the same element in both states, so the label is the
    // only thing that distinguishes them.
    expect(buttonNames()).toEqual([BACK, "Withdraw Request"]);
  });

  it("withholds Accept and explains why when the roles no longer fit", () => {
    // Roles change legitimately at co-op-cycle boundaries. Reject stays,
    // because clearing the request is the way out of the state.
    renderHeader({
      selectedUser: otherUser({
        role: Role.RIDER,
        incomingRequest: PENDING,
      }),
    });

    expect(buttonNames()).toEqual([BACK, "Reject"]);
    expect(
      screen.getByText(/You and Riley are both riders/),
    ).toBeInTheDocument();
  });

  it("offers no request control to a pair already carpooling together", () => {
    // The state `messageHeaderControls` exists for. This slot used to hold a
    // "Leave Conversation" button wired to `onReject`, which deleted their
    // accepted request and destroyed a thread they could not recreate.
    renderHeader({
      selectedUser: otherUser({
        carpoolId: "group-1",
        incomingRequest: { id: "req-1", status: RequestStatus.ACCEPTED },
      }),
      groupId: "group-1",
    });

    expect(buttonNames()).toEqual([BACK]);
  });

  it("refuses a second tap while a mutation is in flight", async () => {
    const onAccept = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      isMutating: true,
      onAccept,
    });

    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();

    await userEvent.click(accept);

    expect(onAccept).not.toHaveBeenCalled();
  });

  it("wires the controls to the panel's handlers", async () => {
    // The handlers were reaching the component the whole time; only the render
    // was missing. This is what makes the new row a control rather than
    // decoration.
    //
    // Reject now takes two presses - see the confirmation suite below. Accept
    // still takes one, deliberately.
    const onAccept = jest.fn();
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onAccept,
      onReject,
    });

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("keeps Reject and Accept 24px apart rather than 12px", () => {
    // **This is a proxy, and only a proxy.** jsdom performs no layout and
    // resolves no Tailwind, so every element here measures zero whatever its
    // classes say - `testing/viewport.ts` has the measured list. What is
    // observable is the class that carries the separation, and the defect was
    // exactly a class: `gap-3` on a row of two `flex-1` buttons put a
    // destructive action 12px from a constructive one, where the desktop pair
    // carry `mr-10`. The 24px itself is a device check.
    renderHeader({ selectedUser: otherUser({ incomingRequest: PENDING }) });

    const row = screen.getByRole("button", { name: "Reject" }).parentElement;

    expect(row).toHaveClass("gap-6");
    expect(row).not.toHaveClass("gap-3");
  });
});

describe("Conversation header controls on desktop", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("offers each control exactly once for a pending incoming request", () => {
    renderHeader({ selectedUser: otherUser({ incomingRequest: PENDING }) });

    // The exact list, so a control rendered by both the shared component and
    // a leftover copy of the old JSX fails here rather than looking fine.
    expect(buttonNames()).toEqual(["Reject", "Accept", CLOSE]);
  });

  it("offers Withdraw Request exactly once for a pending outgoing request", () => {
    renderHeader({ selectedUser: otherUser({ outgoingRequest: PENDING }) });

    expect(buttonNames()).toEqual(["Withdraw Request", CLOSE]);
  });

  it("keeps the role-mismatch explanation it already had", () => {
    renderHeader({
      selectedUser: otherUser({
        role: Role.RIDER,
        incomingRequest: PENDING,
      }),
    });

    expect(buttonNames()).toEqual(["Reject", CLOSE]);
    expect(
      screen.getByText(/You and Riley are both riders/),
    ).toBeInTheDocument();
  });

  it("offers no request control to a pair already carpooling together", () => {
    renderHeader({
      selectedUser: otherUser({
        carpoolId: "group-1",
        incomingRequest: { id: "req-1", status: RequestStatus.ACCEPTED },
      }),
      groupId: "group-1",
    });

    expect(buttonNames()).toEqual([CLOSE]);
  });
});

/**
 * The confirmation step in front of the button that clears a request.
 *
 * `onReject` runs `requests.delete`, which removes the `Request` row and takes
 * the conversation with it - and there is no undo. It was a single press, and
 * on mobile that press was 12px from Accept as one of two half-width thumb
 * targets, against a finger's roughly 8px of positional slop. This file
 * already records what the same slot cost once before: a "Leave Conversation"
 * button wired to the same handler destroyed accepted requests and their
 * threads until it was removed.
 *
 * Both states of that one button are confirmed, Reject and Withdraw Request.
 * They are the same element on the same handler with a different label, and
 * both end in the same deletion. Accept is not, and must not be: it already
 * refuses a second press through `isMutating`.
 *
 * The step is the in-place two-step `GroupMemberCard` uses for Delete Group,
 * Leave Group and Remove, reused rather than reinvented - with one deliberate
 * difference, asserted below: Cancel comes first.
 */
describe("Clearing a request asks first", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("deletes nothing on the first press", async () => {
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onReject,
    });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onReject).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Reject this request\? This also deletes/),
    ).toBeInTheDocument();
  });

  it("puts Cancel where the finger that just pressed Reject already is", async () => {
    // The ordering is the point of the step, not a detail of it. An impatient
    // second press in the same place is the likeliest way to defeat a two-step
    // confirmation, so the first slot holds the harmless answer. Accept is
    // withdrawn while the question is open, so there is nothing destructive
    // *or* constructive left in the row to hit by accident.
    renderHeader({ selectedUser: otherUser({ incomingRequest: PENDING }) });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(buttonNames()).toEqual([BACK, "Cancel", "Confirm"]);
  });

  it("does not dress Confirm as Accept", async () => {
    // A class proxy, for the same reason as the gap above - but the defect it
    // guards is a visual one that a measured browser check found and no
    // behavioural test could: `primary` is `bg-northeastern-red`, the brand
    // colour and *not* a danger colour, and Accept wears it. A filled-red
    // Confirm therefore looks like Accept while standing in the slot Accept
    // just vacated, which is the strongest possible invitation to the mis-tap
    // this whole step exists to prevent. Outlined clears the request in both
    // states of the row; filled red is the affirmative answer in both.
    renderHeader({ selectedUser: otherUser({ incomingRequest: PENDING }) });

    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toHaveClass("bg-northeastern-red");

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.getByRole("button", { name: "Confirm" })).not.toHaveClass(
      "bg-northeastern-red",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
      "bg-northeastern-red",
    );
  });

  it("survives a second press in the same place without deleting anything", async () => {
    // The scenario the ordering above exists for, played out: press, press
    // again where you just pressed. The request is still there.
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onReject,
    });

    const row = () => screen.getAllByRole("button")[1];

    await userEvent.click(row());
    await userEvent.click(row());

    expect(onReject).not.toHaveBeenCalled();
    expect(buttonNames()).toEqual([BACK, "Reject", "Accept"]);
  });

  it("deletes once Confirm is pressed, exactly once", async () => {
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onReject,
    });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("puts the original controls back on Cancel", async () => {
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onReject,
    });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onReject).not.toHaveBeenCalled();
    expect(buttonNames()).toEqual([BACK, "Reject", "Accept"]);
  });

  it("asks before withdrawing too, in the words of that state", async () => {
    // One button, two labels, one handler, one deletion. Gating the
    // confirmation to only one of the two states would be a conditional with
    // nothing behind it.
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ outgoingRequest: PENDING }),
      onReject,
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Withdraw Request" }),
    );

    expect(onReject).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Withdraw this request\? This also deletes/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("still confirms when a role mismatch has already taken Accept away", async () => {
    // Clearing the request is the way out of a mismatch, so Reject is the only
    // control here. The prompt displaces the explanation while it is open; the
    // explanation comes back on Cancel.
    renderHeader({
      selectedUser: otherUser({ role: Role.RIDER, incomingRequest: PENDING }),
    });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(buttonNames()).toEqual([BACK, "Cancel", "Confirm"]);
    expect(
      screen.queryByText(/You and Riley are both riders/),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.getByText(/You and Riley are both riders/),
    ).toBeInTheDocument();
  });

  it("cannot be opened while a mutation is already in flight", async () => {
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      isMutating: true,
      onReject,
    });

    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();

    await userEvent.click(reject);

    expect(onReject).not.toHaveBeenCalled();
    expect(buttonNames()).toEqual([BACK, "Reject", "Accept"]);
  });

  it("does not carry a half-answered question into the next conversation", async () => {
    // Both branches key `RequestControls` on the counterpart's id for this.
    // `MessagePanel` renders one `MessageHeader` at a fixed position and swaps
    // `selectedUser` underneath it, so without the key an abandoned
    // confirmation would be inherited by the next person's request - and
    // Confirm would then delete a request its owner never pressed Reject on.
    const onReject = jest.fn();
    const first = otherUser({ id: "other-1", incomingRequest: PENDING });
    const second = otherUser({
      id: "other-2",
      preferredName: "Sam",
      incomingRequest: PENDING,
    });

    const { rerender } = renderHeader({ selectedUser: first, onReject });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(buttonNames()).toEqual([BACK, "Cancel", "Confirm"]);

    rerender(headerElement({ selectedUser: second, onReject }));

    expect(buttonNames()).toEqual([BACK, "Reject", "Accept"]);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("asks on desktop as well, where the same handler deletes the same row", async () => {
    setViewportWidth(DESKTOP_WIDTH);
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onReject,
    });

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(buttonNames()).toEqual(["Cancel", "Confirm", CLOSE]);
    expect(onReject).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onReject).toHaveBeenCalledTimes(1);
  });
});

/**
 * The mobile back control.
 *
 * It was a bare 24px SVG in a button with no padding, so the icon was the
 * whole tap target — a third of the 44px Apple's HIG and WCAG 2.5.5 ask for,
 * on the *only* control that leaves a conversation on a phone. The padding
 * that fixes it is a class, and **jsdom cannot see it**: no layout is
 * performed, so every element measures zero whatever its declared size, and
 * `getComputedStyle` resolves no Tailwind class. See `testing/viewport.ts`.
 *
 * So nothing here measures anything. What these hold instead is everything
 * about the control that a class change could break by accident: that it is
 * still a real `button`, still carries its accessible name, still calls
 * `onClose`, and is still reachable from the keyboard. The size itself is a
 * device check, and the compiled stylesheet is the other half of the evidence.
 */
describe("The mobile back control", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("is a real button carrying its own accessible name", () => {
    // `aria-label` is the only source: the control has no text, and the arrow
    // is `aria-hidden`. A div with an onClick would satisfy a click test and
    // fail this one.
    renderHeader();

    const back = screen.getByRole("button", { name: BACK });
    expect(back.tagName).toBe("BUTTON");
    expect(back).toHaveAttribute("type", "button");
  });

  it("leaves the conversation when tapped", () => {
    const onClose = jest.fn();
    renderHeader({ onClose });

    screen.getByRole("button", { name: BACK }).click();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is reachable and operable from the keyboard", async () => {
    // Free with a real `button`, and the point is that it stays free: the
    // padding is on the button itself rather than on a wrapper, so the focus
    // ring and the Enter/Space handling belong to the thing with the target.
    const onClose = jest.fn();
    renderHeader({ onClose });

    await userEvent.tab();
    expect(screen.getByRole("button", { name: BACK })).toHaveFocus();

    await userEvent.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is the only way out on mobile, which is why its target matters", () => {
    // The desktop `×` is below the early return. If that ever changes, the
    // back arrow stops being load-bearing and this whole ticket's premise
    // needs revisiting - so assert the premise rather than assume it.
    renderHeader();

    expect(screen.getByRole("button", { name: BACK })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CLOSE }),
    ).not.toBeInTheDocument();
  });

  it("is absent on desktop, where the close control takes over", () => {
    setViewportWidth(DESKTOP_WIDTH);
    renderHeader();

    expect(
      screen.queryByRole("button", { name: BACK }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: CLOSE })).toBeInTheDocument();
  });
});
