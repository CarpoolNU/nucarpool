import { RequestStatus, Role, Status } from "@prisma/client";
import { carpoolUnavailableExplanation } from "../../utils/roleCompatibility";
import { hasSeatAvailable } from "../../utils/carpoolSeats";

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
  otherRole,
  otherStatus,
}: {
  incomingRequest: RequestState;
  outgoingRequest: RequestState;
  /** The viewer's own role. `undefined` before `user.me` resolves. */
  viewerRole: Role | undefined;
  seatAvail: number | undefined;
  preferredName: string;
  /** The other person's role, for the compatibility refusal below. */
  otherRole: Role;
  /** Whether the other person's search is paused. */
  otherStatus: Status;
}): ConnectAction => {
  // Checked first, and ahead of the request refusals, because it is the more
  // fundamental fact: a pair who cannot carpool at all should not hear about
  // the state of a request between them, and the card is already showing this
  // very sentence as its notice — the button must not contradict it.
  //
  // This branch exists for SCRUM-351. `favorites.me` no longer hides a
  // favourite whose role changed or whose search was paused, so a Connect
  // button can now sit on a card for someone the pair can never carpool with.
  // Without this, pressing it would open the modal and `requests.create` would
  // happily write the request - there is no role guard on the server, only on
  // `groups.create`/`groups.edit` - leaving a request that can be sent but
  // never accepted.
  //
  // Recommendation cards cannot reach it: `calculateScore` drops every
  // incompatible role and `buildCandidateWhere` never returns an INACTIVE row,
  // so for that caller this is always `null`.
  //
  // Scoped to what the *other* person's role and status make impossible. A
  // reader who is themselves a VIEWER is deliberately excluded: that is not
  // SCRUM-351's defect, this function has never refused on it, and the UI
  // already disables both Connect buttons for a VIEWER. `ConnectCard` still
  // shows them the notice, because `carpoolUnavailableExplanation` answers the
  // reader's own Viewer mode first - it is the card that explains, and this
  // that refuses, and the two are allowed to cover different ground.
  if (viewerRole && viewerRole !== Role.VIEWER) {
    const unavailable = carpoolUnavailableExplanation(viewerRole, {
      role: otherRole,
      status: otherStatus,
      preferredName,
    });

    if (unavailable) {
      return { kind: "blocked", message: unavailable };
    }
  }

  // Order preserved from the original: an outstanding request in either
  // direction is reported before the seat check, so a driver with no seats and
  // a pending request hears about the request rather than the seats.
  if (isOutstanding(incomingRequest)) {
    return { kind: "blocked", message: incomingPending(preferredName) };
  }

  if (isOutstanding(outgoingRequest)) {
    return { kind: "blocked", message: outgoingPending(preferredName) };
  }

  // SCRUM-348 made that decision: non-positive is unavailable, via the
  // `hasSeatAvailable` predicate `reserveSeat` already used. A driver at a
  // negative count is now told they have no space instead of being sent to a
  // modal whose acceptance the server refuses.
  //
  // `undefined` still falls through as open, which is not an oversight — it is
  // "seats not loaded yet", and the block below would otherwise refuse a
  // perfectly good driver for the moment before `user.me` resolves.
  if (
    viewerRole === Role.DRIVER &&
    seatAvail !== undefined &&
    !hasSeatAvailable(seatAvail)
  ) {
    return { kind: "blocked", message: noSeats(preferredName) };
  }

  return { kind: "open" };
};
