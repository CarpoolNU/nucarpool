import { RequestStatus, Role } from "@prisma/client";
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

const action = (over: Partial<Parameters<typeof connectAction>[0]> = {}) =>
  connectAction({
    incomingRequest: undefined,
    outgoingRequest: undefined,
    viewerRole: Role.RIDER,
    seatAvail: 0,
    preferredName: "Sam",
    ...over,
  });

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

  it("leaves a negative seat count to SCRUM-348 rather than handling it here", () => {
    // `=== 0` is preserved deliberately, so a driver whose count went negative
    // is not refused by this check. That row is a real state in production
    // data; repairing it and deciding the comparison belong to SCRUM-348, and
    // changing it here would silently widen this fix.
    expect(action({ viewerRole: Role.DRIVER, seatAvail: -1 })).toEqual({
      kind: "open",
    });
  });
});
