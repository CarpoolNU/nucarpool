import { RequestStatus } from "@prisma/client";

/**
 * Which request controls the conversation header offers, for one pair.
 *
 * Extracted from `MessageHeader` for the same reason `connectAction` was
 * extracted from `ConnectCard`: the rule is worth pinning where a test can
 * state it as a rule. When this was written the component was not reachable
 * from a test at all; the jsdom project changed that, and `MessageHeader.test.tsx`
 * now renders it at both viewports — but a table of states reads better as a
 * table than as a dozen renders, and the extraction stays.
 *
 * The two are not alternatives, and the difference is worth stating: this
 * table was right the whole time a mobile viewport rendered *none* of what it
 * returns, because the component's mobile branch returned before reaching the
 * controls. A rule test cannot see that; only a render can.
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
 * conversation, but it is no longer a question. This used to be a plain
 * presence check, which is why an accepted request kept showing its Accept
 * button.
 *
 * **A pair already in the same group get `none`, and that is the fix.** The
 * header used to offer them a "Leave Conversation" button wired to the same
 * `onReject` handler as Reject and Withdraw — so pressing it deleted their
 * `ACCEPTED` request row. That destroyed a thread they could not get back:
 * `getConversationMessages` throws NOT_FOUND without a request, and
 * `requests.create` refuses with CONFLICT while the two share a `carpoolId`.
 * The group itself was untouched, so they stayed carpool partners with no way
 * to message each other, and the toast afterwards described somebody else's
 * request being deleted.
 *
 * The button was removed rather than repaired. Both readings of its label were
 * already served: the header's own `×` closes the panel, and the Group page's
 * `useGroupMembership` leaves the carpool, with correct copy and cache
 * invalidation. Its only unique effect was the data loss. It was also
 * desktop-only — the mobile header never had it — which is itself a sign it
 * was not a considered feature.
 *
 * The role-compatibility case is deliberately *not* handled here. A pending
 * request whose parties can no longer carpool still offers Reject and
 * Withdraw, because clearing it is the way out and the absence of any route to
 * that was its own dead end. Only Accept is withheld, and
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
