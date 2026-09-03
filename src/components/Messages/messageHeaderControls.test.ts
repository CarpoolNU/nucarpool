import { RequestStatus } from "@prisma/client";
import { messageHeaderControls } from "./messageHeaderControls";

/**
 * The conversation header's request controls.
 *
 * `MessageHeader` renders these and cannot be tested — no jsdom, no React
 * testing library — so the rule was extracted here, the way `connectAction`
 * was extracted from `ConnectCard`.
 *
 * The case this exists for is the last block: a pair already carpooling
 * together get **no** control. That slot used to hold a "Leave Conversation"
 * button wired to the same `onReject` handler as Reject and Withdraw, so
 * pressing it deleted their accepted request and destroyed a thread they could
 * not recreate.
 */

const GROUP = "group-1";

const controls = (over: Partial<Parameters<typeof messageHeaderControls>[0]>) =>
  messageHeaderControls({
    incomingStatus: undefined,
    outgoingStatus: undefined,
    groupId: null,
    otherCarpoolId: null,
    ...over,
  });

describe("messageHeaderControls", () => {
  it("offers a response to a request awaiting this reader's answer", () => {
    expect(controls({ incomingStatus: RequestStatus.PENDING })).toEqual({
      kind: "respond",
    });
  });

  it("offers a withdrawal for this reader's own pending request", () => {
    expect(controls({ outgoingStatus: RequestStatus.PENDING })).toEqual({
      kind: "withdraw",
    });
  });

  it("prefers responding when both directions are somehow pending", () => {
    // The duplicate-request state SCRUM-349 closed. Answering the request sent
    // *to* you is the more useful of the two, and the header must pick one:
    // the two blocks used to be guarded by `!hasIncomingRequest` in the JSX,
    // and now the type makes it impossible to render both.
    expect(
      controls({
        incomingStatus: RequestStatus.PENDING,
        outgoingStatus: RequestStatus.PENDING,
      }),
    ).toEqual({ kind: "respond" });
  });

  it("offers nothing when there is no request at all", () => {
    expect(controls({})).toEqual({ kind: "none" });
  });

  it("offers nothing for an accepted request", () => {
    // The row stays attached so the pair keep their conversation, but it is no
    // longer a question. A presence check here is what once kept showing an
    // Accept button for a request that had already been accepted.
    expect(controls({ incomingStatus: RequestStatus.ACCEPTED })).toEqual({
      kind: "none",
    });
    expect(controls({ outgoingStatus: RequestStatus.ACCEPTED })).toEqual({
      kind: "none",
    });
  });

  /**
   * SCRUM-362. Every shape of "these two are carpooling together" resolves to
   * a header with nothing in it that writes.
   */
  describe("a pair already in the same group", () => {
    it("gets no control, so nothing there can delete their thread", () => {
      expect(
        controls({
          incomingStatus: RequestStatus.ACCEPTED,
          groupId: GROUP,
          otherCarpoolId: GROUP,
        }),
      ).toEqual({ kind: "none" });
    });

    it("gets none even if a request is somehow still pending", () => {
      // Belt and braces: the group check runs first deliberately, so no
      // combination of request states can put a button in front of a grouped
      // pair. Both of these would have rendered one before.
      expect(
        controls({
          incomingStatus: RequestStatus.PENDING,
          groupId: GROUP,
          otherCarpoolId: GROUP,
        }),
      ).toEqual({ kind: "none" });
      expect(
        controls({
          outgoingStatus: RequestStatus.PENDING,
          groupId: GROUP,
          otherCarpoolId: GROUP,
        }),
      ).toEqual({ kind: "none" });
    });

    it("still offers a response when the two are in different groups", () => {
      // Sharing a `carpoolId` is the test, not merely having one. A reader in
      // one group looking at someone in another can still act on a request.
      expect(
        controls({
          incomingStatus: RequestStatus.PENDING,
          groupId: GROUP,
          otherCarpoolId: "group-2",
        }),
      ).toEqual({ kind: "respond" });
    });

    it("still offers a response when only the reader is grouped", () => {
      expect(
        controls({
          incomingStatus: RequestStatus.PENDING,
          groupId: GROUP,
          otherCarpoolId: null,
        }),
      ).toEqual({ kind: "respond" });
    });

    it("still offers a response when only the counterpart is grouped", () => {
      // `groupId` null with a grouped counterpart must not be read as a match.
      expect(
        controls({
          incomingStatus: RequestStatus.PENDING,
          groupId: null,
          otherCarpoolId: GROUP,
        }),
      ).toEqual({ kind: "respond" });
    });

    it("does not treat two ungrouped people as sharing a group", () => {
      // The null === null trap: both `carpoolId`s absent is the ordinary case
      // for a new request, and reading it as "same group" would remove the
      // Accept button from every first-time pair.
      expect(
        controls({
          incomingStatus: RequestStatus.PENDING,
          groupId: null,
          otherCarpoolId: null,
        }),
      ).toEqual({ kind: "respond" });
    });

    it("does not treat an undefined counterpart carpoolId as a match", () => {
      expect(
        controls({
          incomingStatus: RequestStatus.PENDING,
          groupId: null,
          otherCarpoolId: undefined,
        }),
      ).toEqual({ kind: "respond" });
    });
  });
});
