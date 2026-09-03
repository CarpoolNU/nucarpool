import { RequestStatus, Role, Status } from "@prisma/client";
import { connectAction } from "./connectAction";

/**
 * SCRUM-354: a spent request is not a pending one.
 *
 * `handleConnect` tested a request's *presence*, so a resolved request
 * suppressed the Connect modal exactly as an outstanding one did — and told the
 * user either to wait for a response nobody owed them, or to visit a tab whose
 * Accept button does not render for a resolved request. The journey it blocked
 * is a real one: carpooling again with someone after the group has ended, which
 * SCRUM-353 made depend on sending a fresh request.
 *
 * The four cases that matter most are the two `ACCEPTED` ones — which used to
 * be refused and now fall through — and the two `PENDING` ones, which must keep
 * being refused, or this fix would let a user pile up duplicate requests.
 */

const pending = { status: RequestStatus.PENDING };
const accepted = { status: RequestStatus.ACCEPTED };

const action = (over: Partial<Parameters<typeof connectAction>[0]> = {}) => {
  const viewerRole = "viewerRole" in over ? over.viewerRole : Role.RIDER;

  return connectAction({
    incomingRequest: undefined,
    outgoingRequest: undefined,
    viewerRole,
    seatAvail: 0,
    preferredName: "Sam",
    // Whichever role *fits* the viewer, so the SCRUM-351 compatibility refusal
    // stays out of the way of every case that is not about it. A test that
    // wants that refusal names `otherRole` itself.
    otherRole: viewerRole === Role.DRIVER ? Role.RIDER : Role.DRIVER,
    otherStatus: Status.ACTIVE,
    ...over,
  });
};

describe("connectAction — no request between the two users", () => {
  it("opens the modal", () => {
    expect(action()).toEqual({ kind: "open" });
  });

  it("opens the modal for a null request as well as an absent one", () => {
    // `requests.me` filters out counterparts whose search is INACTIVE, so the
    // client can hold a null where a request would be.
    expect(action({ incomingRequest: null, outgoingRequest: null })).toEqual({
      kind: "open",
    });
  });
});

describe("connectAction — an outstanding request still refuses", () => {
  it("refuses when the other person has asked and is waiting", () => {
    const result = action({ incomingRequest: pending });

    expect(result.kind).toBe("blocked");
    expect(result).toMatchObject({
      message:
        "You already have an incoming carpool request from Sam. " +
        "Navigate to the received requests tab to connect with them!",
    });
  });

  it("refuses when the viewer has already asked", () => {
    const result = action({ outgoingRequest: pending });

    expect(result.kind).toBe("blocked");
    expect(result).toMatchObject({
      message:
        "You already have an outgoing carpool request to Sam. " +
        "Please wait for them to respond to your request!",
    });
  });

  it("reports an outstanding request ahead of the seat check", () => {
    // Order preserved from the original: a driver with no seats and a pending
    // request hears about the request, which is the thing they can act on.
    const result = action({
      outgoingRequest: pending,
      viewerRole: Role.DRIVER,
      seatAvail: 0,
    });

    expect(result).toMatchObject({
      message: expect.stringContaining("outgoing carpool request"),
    });
  });

  it("prefers the incoming request when somehow both are outstanding", () => {
    const result = action({
      incomingRequest: pending,
      outgoingRequest: pending,
    });

    expect(result).toMatchObject({
      message: expect.stringContaining("incoming carpool request"),
    });
  });
});

describe("connectAction — a spent request no longer refuses", () => {
  it("opens the modal when the incoming request has been accepted", () => {
    // The defect. This is a pair who carpooled and whose group has ended: the
    // row stays ACCEPTED forever, so Connect refused forever.
    expect(action({ incomingRequest: accepted })).toEqual({ kind: "open" });
  });

  it("opens the modal when the outgoing request has been accepted", () => {
    expect(action({ outgoingRequest: accepted })).toEqual({ kind: "open" });
  });

  it("says nothing at all rather than something untrue", () => {
    // The old copy claimed a response was awaited, or sent the user to a tab
    // with no Accept button on it. Neither was true of a resolved request, and
    // the fix is that no message is raised for one.
    const incoming = action({ incomingRequest: accepted });
    const outgoing = action({ outgoingRequest: accepted });

    expect(incoming).not.toHaveProperty("message");
    expect(outgoing).not.toHaveProperty("message");
  });

  it("still opens for a driver who has a seat and a spent request", () => {
    // The whole recovery path in one case: a past carpool partner, a driver
    // with room, and nothing outstanding between them.
    expect(
      action({
        outgoingRequest: accepted,
        viewerRole: Role.DRIVER,
        seatAvail: 2,
      }),
    ).toEqual({ kind: "open" });
  });
});

describe("connectAction — seat availability", () => {
  it("refuses a driver with no seats", () => {
    const result = action({ viewerRole: Role.DRIVER, seatAvail: 0 });

    expect(result).toMatchObject({
      message:
        "You do not have any seats available in your car to connect with Sam.",
    });
  });

  it("does not apply the seat check to a rider", () => {
    // A rider's own `seatAvail` is zero and means nothing; only a driver is
    // offering space.
    expect(action({ viewerRole: Role.RIDER, seatAvail: 0 })).toEqual({
      kind: "open",
    });
  });

  it("does not apply the seat check to a viewer", () => {
    expect(action({ viewerRole: Role.VIEWER, seatAvail: 0 })).toEqual({
      kind: "open",
    });
  });

  it("opens for a driver who has seats", () => {
    expect(action({ viewerRole: Role.DRIVER, seatAvail: 3 })).toEqual({
      kind: "open",
    });
  });

  it("does not refuse before the viewer's own profile has loaded", () => {
    // `user` is undefined until `user.me` resolves. Refusing then would block
    // the first click after a page load; the server is the authority anyway.
    expect(action({ viewerRole: undefined, seatAvail: undefined })).toEqual({
      kind: "open",
    });
  });

  it("refuses a driver whose seat count went negative", () => {
    // SCRUM-348 made the call this test used to defer: non-positive is
    // unavailable. A driver at -1 is a real state in production data, and
    // `reserveSeat` would refuse the acceptance anyway — so opening the modal
    // only led to a server error naming the driver as having no space.
    expect(action({ viewerRole: Role.DRIVER, seatAvail: -1 })).toEqual({
      kind: "blocked",
      message:
        "You do not have any seats available in your car to connect with Sam.",
    });
  });
});

/**
 * SCRUM-351: a favourite the reader cannot carpool with.
 *
 * `favorites.me` used to drop any favourite whose role matched the reader's,
 * was VIEWER, or whose search was INACTIVE — which removed the card, and with
 * it the only star that can un-favourite them. They are returned now, so a
 * Connect button can sit on a card for a pair who can never carpool. Nothing on
 * the server stops that request being written: `requests.create` has no role
 * guard, only `groups.create`/`groups.edit` do. So this refusal is what keeps a
 * request that can be sent but never accepted from being created at all.
 *
 * `ConnectCard` also disables the button and shows the same sentence as the
 * card's notice, but neither of those is reachable from a test in this
 * repository — there is no jsdom and no React testing library. This is the
 * layer that can be pinned.
 */
describe("connectAction — a favourite who cannot be carpooled with", () => {
  it("refuses two riders, and says which way out there is", () => {
    const result = action({ viewerRole: Role.RIDER, otherRole: Role.RIDER });

    expect(result).toEqual({
      kind: "blocked",
      message:
        "You and Sam are both riders, so neither of you can drive. " +
        "One of you would need to switch to Driver.",
    });
  });

  it("refuses two drivers", () => {
    // `seatAvail` is deliberately non-zero: the refusal must be about the pair,
    // not smuggled in by the seat check further down.
    const result = action({
      viewerRole: Role.DRIVER,
      otherRole: Role.DRIVER,
      seatAvail: 3,
    });

    expect(result).toEqual({
      kind: "blocked",
      message:
        "You and Sam are both drivers, so you cannot carpool together. " +
        "One of you would need to switch to Rider.",
    });
  });

  it("refuses a favourite who has switched to Viewer mode, without request copy", () => {
    const result = action({ viewerRole: Role.RIDER, otherRole: Role.VIEWER });

    expect(result).toEqual({
      kind: "blocked",
      message:
        "Sam has switched to Viewer mode and is not carpooling right now.",
    });
    // The requests wording ends "or clear the request". There is no request on
    // a favourite, so that instruction must not appear here.
    expect(result).not.toMatchObject({
      message: expect.stringContaining("request"),
    });
  });

  it("refuses a favourite whose search is paused", () => {
    const result = action({ otherStatus: Status.INACTIVE });

    expect(result).toEqual({
      kind: "blocked",
      message:
        "Sam has paused their carpool search, so you cannot carpool with " +
        "them right now.",
    });
  });

  it("does not refuse on the reader's own Viewer mode", () => {
    // Deliberate boundary. This refusal is about what the *other* person's
    // role and status make impossible, which is SCRUM-351's defect; the
    // reader's own Viewer mode is not, this function has never refused on it,
    // and both Connect buttons are already `disabled` for a VIEWER. The card
    // still explains it - `carpoolUnavailableExplanation` answers the reader's
    // own Viewer mode first, and `ConnectCard` calls it directly for the
    // notice.
    expect(action({ viewerRole: Role.VIEWER, otherRole: Role.DRIVER })).toEqual(
      {
        kind: "open",
      },
    );
  });

  it("reports the incompatibility ahead of a pending request", () => {
    // The card is already showing the incompatibility as its notice, so a
    // refusal naming the request instead would contradict what the reader can
    // see. It is also the more fundamental fact: no request between this pair
    // can be accepted regardless of its status.
    const result = action({
      viewerRole: Role.RIDER,
      otherRole: Role.RIDER,
      incomingRequest: pending,
    });

    expect(result).toMatchObject({
      message: expect.stringContaining("both riders"),
    });
  });

  it("still opens for a compatible, actively searching favourite", () => {
    // The regression that matters most: the ordinary favourite must be
    // untouched by any of the above.
    expect(action({ viewerRole: Role.RIDER, otherRole: Role.DRIVER })).toEqual({
      kind: "open",
    });
  });
});
