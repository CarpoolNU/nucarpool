import { RequestStatus, Role } from "@prisma/client";

/**
 * What pressing **Connect** on a discovery card should do.
 *
 * The rule is that an *outstanding* request is what stops you sending another
 * one. `handleConnect` used to test for a request's mere presence, which is a
 * different thing: `incomingRequest` and `outgoingRequest` are built in
 * `index.tsx` from `requests.received` / `requests.sent` with no status filter,
 * so a resolved request suppressed the modal exactly as a pending one did.
 *
 * That made the whole "carpool with them again" journey unreachable. Once a
 * pair have carpooled and the group has ended, their request sits at
 * `ACCEPTED` forever — `markRequestAccepted` resolves the row rather than
 * deleting it, because `sendAcceptanceNotification` reads it and the
 * conversation hangs off its id. So Connect refused, and the two things it
 * suggested were both false: nothing was awaiting a response, and the received
 * requests tab has no Accept button for a resolved request either
 * (`MessageHeader` gates Accept, Reject and Withdraw on PENDING). The user was
 * told to go somewhere that could not help them, about a request nobody had to
 * answer.
 *
 * SCRUM-353 is what makes this load-bearing rather than merely untidy. The
 * server now requires a **pending** request before it will build a group, and
 * `requests.create` reopens a resolved row to `PENDING` — rewriting the
 * direction so whoever asks now is the sender. That is the entire recovery
 * path, and this predicate is what lets a user reach it.
 *
 * The messages are unchanged. They were never wrong about a *pending* request;
 * they were only ever raised in the wrong situation. Fixing when they fire
 * fixes what they claim.
 *
 * Extracted as a pure function rather than left inline for the reason
 * `viewerAccess.ts` gives: this repository has no component tests, so a rule
 * deciding what a user can reach has to live somewhere a test can see it.
 */

/** Only the part of a request this decision reads. */
type RequestState = { status: RequestStatus } | null | undefined;

export type ConnectAction =
  { kind: "open" } | { kind: "blocked"; message: string };

/**
 * A request still awaiting an answer. Anything else — resolved, or absent —
 * is not a reason to refuse a new one.
 *
 * Matches `MessageHeader`'s `hasIncomingRequest` / `hasOutgoingRequest`
 * exactly, which is the point: the tab that offers Accept and the card that
 * offers Connect have to agree about what "you already have a request" means,
 * or one of them sends the user to the other for nothing.
 */
const isOutstanding = (request: RequestState): boolean =>
  request?.status === RequestStatus.PENDING;

const incomingPending = (name: string) =>
  `You already have an incoming carpool request from ${name}. ` +
  "Navigate to the received requests tab to connect with them!";

const outgoingPending = (name: string) =>
  `You already have an outgoing carpool request to ${name}. ` +
  "Please wait for them to respond to your request!";

const noSeats = (name: string) =>
  `You do not have any seats available in your car to connect with ${name}.`;

export const connectAction = ({
  incomingRequest,
  outgoingRequest,
  viewerRole,
  seatAvail,
  preferredName,
}: {
  incomingRequest: RequestState;
  outgoingRequest: RequestState;
  /** The viewer's own role. `undefined` before `user.me` resolves. */
  viewerRole: Role | undefined;
  seatAvail: number | undefined;
  preferredName: string;
}): ConnectAction => {
  // Order preserved from the original: an outstanding request in either
  // direction is reported before the seat check, so a driver with no seats and
  // a pending request hears about the request rather than the seats.
  if (isOutstanding(incomingRequest)) {
    return { kind: "blocked", message: incomingPending(preferredName) };
  }

  if (isOutstanding(outgoingRequest)) {
    return { kind: "blocked", message: outgoingPending(preferredName) };
  }

  // `=== 0` rather than `<= 0`, preserving the existing check exactly. A
  // negative seat count is a real state in production data and is deliberately
  // not handled here — see SCRUM-348, which owns both the repair and the
  // decision about which comparison the app should use.
  if (viewerRole === Role.DRIVER && seatAvail === 0) {
    return { kind: "blocked", message: noSeats(preferredName) };
  }

  return { kind: "open" };
};
