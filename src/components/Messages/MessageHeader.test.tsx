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

const renderHeader = (
  over: {
    selectedUser?: EnhancedPublicUser;
    viewer?: User;
    groupId?: string | null;
    isMutating?: boolean;
    onAccept?: () => void;
    onReject?: () => void;
  } = {},
) =>
  render(
    <UserContext.Provider value={over.viewer ?? VIEWER}>
      <MessageHeader
        selectedUser={over.selectedUser ?? otherUser()}
        onAccept={over.onAccept ?? (() => undefined)}
        onReject={over.onReject ?? (() => undefined)}
        onClose={() => undefined}
        groupId={over.groupId ?? null}
        isMutating={over.isMutating ?? false}
      />
    </UserContext.Provider>,
  );

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
    const onAccept = jest.fn();
    const onReject = jest.fn();
    renderHeader({
      selectedUser: otherUser({ incomingRequest: PENDING }),
      onAccept,
      onReject,
    });

    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
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
