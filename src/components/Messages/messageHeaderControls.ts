import { RequestStatus } from "@prisma/client";

/**
 * Which request controls the conversation header offers, for one pair.
 *
 * Extracted from `MessageHeader` for the same reason `connectAction` was
 * extracted from `ConnectCard`: the rule is worth pinning where a test can
 * state it as a rule. `MessageHeader.test.tsx` renders the component at both
 * viewports too, but a table of states reads better as a table than as a
 * dozen renders.
 *
 * The two are not alternatives, and the difference is worth stating: a
 * mobile viewport renders *none* of what this table returns, because the
 * component's mobile branch returns before reaching the controls. A rule
 * test cannot see that; only a render can.
 *
 * Three states, and the third is the point.
 */
export type HeaderControls =
  /** A request awaiting this reader's answer: Reject, and Accept unless the roles no longer fit. */
  | { kind: "respond" }
  /** This reader's own request, still awaiting an answer: Withdraw. */
  | { kind: "withdraw" }
  /** Nothing to respond to. No control that writes anything. */
  | { kind: "none" };

type ControlsInput = {
  /** `incomingRequest.status`, or undefined when there is no such request. */
  incomingStatus: RequestStatus | undefined;
  outgoingStatus: RequestStatus | undefined;
  /** The reader's own `carpoolId`. */
  groupId: string | null;
  /** The counterpart's `carpoolId`. */
  otherCarpoolId: string | null | undefined;
};

/**
 * `PENDING` is the whole test for "something to respond to".
 *
 * An `ACCEPTED` request stays attached to the pair so they keep their
 * conversation, but it is no longer a question - a plain presence check
 * would keep showing its Accept button.
 *
 * **A pair already in the same group get `none`.** A "Leave Conversation"
 * button wired to the same `onReject` handler as Reject and Withdraw would
 * delete their `ACCEPTED` request row - destroying a thread they could not
 * get back: `getConversationMessages` throws NOT_FOUND without a request,
 * and `requests.create` refuses with CONFLICT while the two share a
 * `carpoolId`. The group itself would stay untouched, so they would remain
 * carpool partners with no way to message each other.
 *
 * Both readings of a "Leave Conversation" label are already served without
 * one: the header's own `×` closes the panel, and the Group page's
 * `useGroupMembership` leaves the carpool, with correct copy and cache
 * invalidation.
 *
 * The role-compatibility case is deliberately *not* handled here. A pending
 * request whose parties can no longer carpool still offers Reject and
 * Withdraw, because clearing it is the way out, and withholding that route
 * would be its own dead end. Only Accept is withheld, and
 * `roleMismatchExplanation` is what decides that, in the component, next to
 * the copy it prints.
 */
export const messageHeaderControls = ({
  incomingStatus,
  outgoingStatus,
  groupId,
  otherCarpoolId,
}: ControlsInput): HeaderControls => {
  // Already carpooling together. Nothing here is a question, and nothing here
  // may delete anything.
  if (groupId && otherCarpoolId === groupId) {
    return { kind: "none" };
  }

  if (incomingStatus === RequestStatus.PENDING) {
    return { kind: "respond" };
  }

  if (outgoingStatus === RequestStatus.PENDING) {
    return { kind: "withdraw" };
  }

  return { kind: "none" };
};
