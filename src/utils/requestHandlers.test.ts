/**
 * `createRequestHandlers` — the accept/reject gate (SCRUM-294).
 *
 * `handleAcceptRequest` used to resolve `undefined` whether the acceptance had
 * happened or not, so `MessagePanel.handleAccept` could not tell success from
 * refusal and sent the acceptance email and closed the conversation either way.
 * A driver with no seats left got a toast explaining the refusal while the rider
 * got mail saying they had been accepted into a carpool that was never created,
 * and `sendAcceptanceNotification` is deliberately not rate limited, so that
 * call was a real email to a real person.
 *
 * SCRUM-291 and SCRUM-293 gave it the boolean these tests pin: `true` only once
 * a group write has landed. Everything that tells either party the acceptance
 * happened now hangs off that value, so "resolves `false`" is the assertion that
 * no email is sent and the conversation stays open, and "no success toast" is the
 * assertion that nothing on the accepter's own screen claims otherwise either.
 *
 * `trpc` and `react-toastify` are mocked, so `createRequestHandlers` runs outside
 * React and nothing here reaches the network. The click-through itself needs a
 * browser and belongs to SCRUM-264.
 */

import { Permission, RequestStatus, Role, Status } from "@prisma/client";
import type { Request as PrismaRequest } from "@prisma/client";
import { createRequestHandlers } from "./requestHandlers";
import type { EnhancedPublicUser, User } from "./types";

type MutationOptions = {
  onSuccess?: (data: unknown, variables: unknown) => void;
  onError?: (error: unknown) => void;
};

/**
 * Stands in for one `useMutation` result.
 *
 * `mutateAsync` records its variables and, like react-query, runs `onSuccess` or
 * `onError` before settling. The reject path matters as much as the resolve one:
 * `handleRejectRequest` leaves its toast to `onError` and swallows the rejection
 * itself, so a stub that only threw would make that look silent when it is not.
 */
const mockMutation = () => {
  const variables: unknown[] = [];
  let rejection: unknown = null;
  let options: MutationOptions = {};
  let isLoading = false;

  const mutateAsync = jest.fn(async (received: unknown) => {
    variables.push(received);
    if (rejection !== null) {
      options.onError?.(rejection);
      throw rejection;
    }
    options.onSuccess?.(undefined, received);
  });

  return {
    variables,
    mutateAsync,
    useMutation: (received: MutationOptions = {}) => {
      options = received;
      return { mutateAsync, isLoading };
    },
    /** Make every subsequent write reject, the way a server refusal does. */
    rejectWith: (error: unknown) => {
      rejection = error;
    },
    setLoading: (value: boolean) => {
      isLoading = value;
    },
    reset: () => {
      variables.length = 0;
      rejection = null;
      options = {};
      isLoading = false;
      mutateAsync.mockClear();
    },
  };
};

const mockDeleteRequest = mockMutation();
const mockEditGroup = mockMutation();
const mockCreateGroup = mockMutation();

jest.mock("./trpc", () => ({
  trpc: {
    user: {
      requests: {
        delete: {
          useMutation: (options?: MutationOptions) =>
            mockDeleteRequest.useMutation(options),
        },
      },
      groups: {
        edit: {
          useMutation: (options?: MutationOptions) =>
            mockEditGroup.useMutation(options),
        },
        create: {
          useMutation: (options?: MutationOptions) =>
            mockCreateGroup.useMutation(options),
        },
      },
    },
  },
}));

const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock("react-toastify", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

const mockInvalidate = jest.fn();

/**
 * Only the three caches the mutations' `onSuccess` handlers touch. Cast because
 * the real argument is the whole router's worth of query helpers.
 */
const utils = {
  user: {
    me: { invalidate: mockInvalidate },
    requests: { me: { invalidate: mockInvalidate } },
    recommendations: { me: { invalidate: mockInvalidate } },
  },
} as unknown as Parameters<typeof createRequestHandlers>[0];

const handlers = () => createRequestHandlers(utils);

const user = (overrides: Partial<User> = {}): User => ({
  id: "user-1",
  name: "Dana Driver",
  email: "driver@northeastern.edu",
  emailVerified: null,
  image: null,
  bio: "",
  preferredName: "Dana",
  pronouns: "they/them",
  permission: Permission.USER,
  isOnboarded: true,
  licenseSigned: true,
  dateCreated: new Date("2026-01-01T00:00:00.000Z"),
  dateModified: new Date("2026-01-01T00:00:00.000Z"),
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  daysWorking: "1,1,1,1,1,0,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
  carpoolId: null,
  groupNotes: null,
  groupMusicPreference: null,
  groupConversationStyle: null,
  groupMessage: null,
  startCoordLng: -71.1,
  startCoordLat: 42.3,
  startStreet: "1 Home St",
  startCity: "Boston",
  startState: "MA",
  startAddress: "1 Home St, Boston, MA",
  companyCoordLng: -71.2,
  companyCoordLat: 42.4,
  companyStreet: "2 Work Ave",
  companyCity: "Boston",
  companyState: "MA",
  companyAddress: "2 Work Ave, Boston, MA",
  ...overrides,
});

const otherUser = (
  overrides: Partial<EnhancedPublicUser> = {},
): EnhancedPublicUser => ({
  id: "user-2",
  name: "Robin Rider",
  email: "rider@northeastern.edu",
  image: null,
  bio: "",
  preferredName: "Robin",
  pronouns: "they/them",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
  companyName: "Acme",
  startAddress: "3 Other St, Boston, MA",
  startCoordLng: -71.15,
  startCoordLat: 42.35,
  companyAddress: "2 Work Ave, Boston, MA",
  companyCoordLng: -71.2,
  companyCoordLat: 42.4,
  daysWorking: "1,1,1,1,1,0,0",
  startTime: null,
  endTime: null,
  coopStartDate: null,
  coopEndDate: null,
  carpoolId: null,
  isFavorited: false,
  ...overrides,
});

const request: PrismaRequest = {
  id: "request-1",
  message: "Happy to share the drive",
  status: RequestStatus.PENDING,
  fromUserId: "user-2",
  toUserId: "user-1",
  conversationId: "conversation-1",
  dateCreated: new Date("2026-02-01T00:00:00.000Z"),
};

/** No group write of either shape reached the server. */
const expectNothingWritten = () => {
  expect(mockCreateGroup.mutateAsync).not.toHaveBeenCalled();
  expect(mockEditGroup.mutateAsync).not.toHaveBeenCalled();
};

beforeEach(() => {
  mockDeleteRequest.reset();
  mockEditGroup.reset();
  mockCreateGroup.reset();
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
  mockInvalidate.mockClear();
});

describe("handleAcceptRequest — a refused acceptance", () => {
  it("refuses a driver with no seats left, and reports it as not accepted", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ role: Role.DRIVER, seatAvail: 0 }),
      otherUser(),
      request,
    );

    // The `false` is the whole of the fix: it is what stops `MessagePanel`
    // emailing Robin to say they were accepted and closing the conversation.
    expect(accepted).toBe(false);
    expectNothingWritten();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "You do not have any space in your car to accept Robin.",
    );
  });

  it("refuses a driver whose rider is already in a group", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ role: Role.DRIVER, seatAvail: 3 }),
      otherUser({ carpoolId: "group-9" }),
      request,
    );

    expect(accepted).toBe(false);
    expectNothingWritten();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Robin is already in an existing carpool group. Ask them to leave that group before attempting to join yours.",
    );
  });

  it("refuses a rider who is already in a group", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ role: Role.RIDER, carpoolId: "group-9" }),
      otherUser({ role: Role.DRIVER, seatAvail: 2 }),
      request,
    );

    expect(accepted).toBe(false);
    expectNothingWritten();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "You cannot join Robin's group until leaving your current carpool group.",
    );
  });
});

describe("handleAcceptRequest — an acceptance the server refuses", () => {
  it("reports it as not accepted rather than letting the rejection escape", async () => {
    mockCreateGroup.rejectWith(new Error("You already belong to a carpool."));
    const { handleAcceptRequest } = handlers();

    // Resolving rather than rejecting is the point: `handleAccept` is an async
    // onClick handler, so an escaping rejection would be an unhandled one.
    const accepted = await handleAcceptRequest(user(), otherUser(), request);

    expect(accepted).toBe(false);
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as written", async () => {
    mockCreateGroup.rejectWith(new Error("You already belong to a carpool."));
    const { handleAcceptRequest } = handlers();

    await handleAcceptRequest(user(), otherUser(), request);

    // Not relabelled as "Something went wrong": the server is the authority on
    // whether the join is legal, and its message names a rule the user can act
    // on (SCRUM-291).
    expect(mockToastError).toHaveBeenCalledWith(
      "You already belong to a carpool.",
    );
  });

  it("falls back to a generic message when the rejection is not an Error", async () => {
    mockCreateGroup.rejectWith("not an error object");
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(user(), otherUser(), request);

    expect(accepted).toBe(false);
    expect(mockToastError).toHaveBeenCalledWith(
      "That request could not be accepted. Please try again.",
    );
  });
});

describe("handleAcceptRequest — the writes a real acceptance makes", () => {
  it("creates a group for a driver who has none, and reports success", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ role: Role.DRIVER, seatAvail: 3, carpoolId: null }),
      otherUser({ id: "rider-7" }),
      request,
    );

    expect(accepted).toBe(true);
    expect(mockCreateGroup.variables).toEqual([
      { driverId: "user-1", riderId: "rider-7" },
    ]);
    expect(mockEditGroup.mutateAsync).not.toHaveBeenCalled();
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Robin's request to carpool with you has been accepted.",
    );
  });

  it("adds the rider to a driver's existing group", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ role: Role.DRIVER, seatAvail: 2, carpoolId: "group-3" }),
      otherUser({ id: "rider-7" }),
      request,
    );

    expect(accepted).toBe(true);
    expect(mockEditGroup.variables).toEqual([
      { driverId: "user-1", riderId: "rider-7", add: true, groupId: "group-3" },
    ]);
    expect(mockCreateGroup.mutateAsync).not.toHaveBeenCalled();
  });

  it("puts the other user in the driver seat when the accepter is the rider", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ id: "rider-1", role: Role.RIDER, carpoolId: null }),
      otherUser({ id: "driver-4", role: Role.DRIVER, seatAvail: 2 }),
      request,
    );

    expect(accepted).toBe(true);
    expect(mockCreateGroup.variables).toEqual([
      { driverId: "driver-4", riderId: "rider-1" },
    ]);
  });

  it("joins the driver's existing group when the accepter is the rider", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ id: "rider-1", role: Role.RIDER, carpoolId: null }),
      otherUser({
        id: "driver-4",
        role: Role.DRIVER,
        seatAvail: 2,
        carpoolId: "group-5",
      }),
      request,
    );

    expect(accepted).toBe(true);
    expect(mockEditGroup.variables).toEqual([
      {
        driverId: "driver-4",
        riderId: "rider-1",
        add: true,
        groupId: "group-5",
      },
    ]);
  });

  it("invalidates the caches the acceptance has just made stale", async () => {
    const { handleAcceptRequest } = handlers();

    await handleAcceptRequest(user(), otherUser(), request);

    // `requests.me` and `user.me`: the request's status and the accepter's own
    // carpoolId and seat count have all changed.
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });
});

describe("handleRejectRequest", () => {
  it("deletes the request and reports it", async () => {
    const { handleRejectRequest } = handlers();

    await handleRejectRequest(user(), otherUser(), request);

    expect(mockDeleteRequest.variables).toEqual([
      { invitationId: "request-1" },
    ]);
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Robin's request to carpool with you has been deleted.",
    );
  });

  it("does not claim success when the delete fails", async () => {
    mockDeleteRequest.rejectWith(new Error("NOT_FOUND"));
    const { handleRejectRequest } = handlers();

    // Resolves rather than rejects, for the same onClick reason as accept.
    await handleRejectRequest(user(), otherUser(), request);

    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Something went wrong: NOT_FOUND",
    );
  });
});

describe("isMutating", () => {
  it("is false when nothing is in flight", () => {
    expect(handlers().isMutating).toBe(false);
  });

  it("is true while the delete is in flight", () => {
    mockDeleteRequest.setLoading(true);

    expect(handlers().isMutating).toBe(true);
  });

  it("is true while the group edit is in flight", () => {
    mockEditGroup.setLoading(true);

    expect(handlers().isMutating).toBe(true);
  });

  it("is true while the group create is in flight", () => {
    mockCreateGroup.setLoading(true);

    expect(handlers().isMutating).toBe(true);
  });
});

/**
 * A pair who can no longer carpool (SCRUM-296).
 *
 * `user.requests.me` used to drop these requests, so this button never saw one:
 * hiding it did not stop it blocking new requests, and left the sender no way to
 * withdraw it. Now the request stays, which means the accept path has to answer
 * for it - and it cannot go through, because the branches below treat "I am not
 * a DRIVER" as "they are". Two riders would have named one of themselves as the
 * driver; two drivers would have spent a seat filing another driver as a rider.
 *
 * `groups.create` and `groups.edit` refuse the same pairs server-side. This is
 * the fast half, and the only one that can name whose role moved.
 */
describe("handleAcceptRequest - a pair who can no longer carpool", () => {
  const incompatible: [string, Role, Role][] = [
    ["two drivers", Role.DRIVER, Role.DRIVER],
    ["two riders", Role.RIDER, Role.RIDER],
    ["the counterpart has switched to VIEWER", Role.RIDER, Role.VIEWER],
    ["the accepter is in VIEWER mode", Role.VIEWER, Role.RIDER],
  ];

  it.each(incompatible)(
    "resolves false and writes nothing when %s",
    async (_label, mine, theirs) => {
      const { handleAcceptRequest } = handlers();

      const accepted = await handleAcceptRequest(
        user({ role: mine, carpoolId: null, seatAvail: 3 }),
        otherUser({ role: theirs, carpoolId: null }),
        request,
      );

      // False is what stops MessagePanel emailing the other person to say they
      // were accepted into a group that was never created (SCRUM-294).
      expect(accepted).toBe(false);
      expectNothingWritten();
      expect(mockToastSuccess).not.toHaveBeenCalled();
    },
  );

  it("explains which roles are the problem, and names the other person", async () => {
    const { handleAcceptRequest } = handlers();

    await handleAcceptRequest(
      user({ role: Role.RIDER, carpoolId: null }),
      otherUser({ role: Role.RIDER, preferredName: "Robin" }),
      request,
    );

    expect(mockToastError).toHaveBeenCalledTimes(1);
    const [message] = mockToastError.mock.calls[0] as [string];
    expect(message).toContain("Robin");
    expect(message).toContain("both riders");
  });

  it("is checked before the seat and membership rules, which would misread it", async () => {
    // Two drivers, the accepter with no seats. The seat message would be true
    // but beside the point - filling the car would not make this pair a
    // carpool - and for two riders the `else` branch reports a group conflict
    // the other person does not have.
    const { handleAcceptRequest } = handlers();

    await handleAcceptRequest(
      user({ role: Role.DRIVER, seatAvail: 0 }),
      otherUser({ role: Role.DRIVER }),
      request,
    );

    expect(mockToastError).toHaveBeenCalledTimes(1);
    const [message] = mockToastError.mock.calls[0] as [string];
    expect(message).toContain("both drivers");
    expect(message).not.toContain("space in your car");
  });

  it("still accepts the compatible pair it was hiding these behind", async () => {
    const { handleAcceptRequest } = handlers();

    const accepted = await handleAcceptRequest(
      user({ role: Role.DRIVER, seatAvail: 3, carpoolId: null }),
      otherUser({ role: Role.RIDER, carpoolId: null }),
      request,
    );

    expect(accepted).toBe(true);
    expect(mockCreateGroup.mutateAsync).toHaveBeenCalledTimes(1);
  });

  it("does not stop either party clearing the request instead", async () => {
    // The way out of the dead end, so it must not inherit the accept gate.
    const { handleRejectRequest } = handlers();

    await handleRejectRequest(
      user({ role: Role.RIDER }),
      otherUser({ role: Role.RIDER }),
      request,
    );

    expect(mockDeleteRequest.variables).toEqual([
      { invitationId: "request-1" },
    ]);
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
  });
});
