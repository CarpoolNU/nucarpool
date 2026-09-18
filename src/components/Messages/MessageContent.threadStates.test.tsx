/**
 * SCRUM-509: that a conversation gives three different answers, where it used
 * to give one.
 *
 * The message list rendered unconditionally, so "nobody has written anything",
 * "still loading" and "the request failed" were one pixel-identical empty white
 * panel - with `SendBar` live above it, offering to add to a conversation that
 * might not have loaded. The `QueryError` docstring names this as the worst
 * failure mode a matching product has: "silent empty lists made a real outage
 * look like nobody was using the app".
 *
 * **All three states are asserted in this one file deliberately.** The
 * distinction is the deliverable, and a file that only pinned the failure case
 * would let it collapse back to two - which is how it got here. Each test
 * additionally asserts the *absence* of the other two outputs, so no pair of
 * states can quietly become the same again.
 *
 * The empty case is not an edge case but the normal first paint:
 * `requests.create` stores the opening text as a `Message` rather than in
 * `request.message`, so `request?.message` is `""` for every modern row and
 * `allMessages` is empty until this query resolves.
 *
 * **Real React Query with a controllable `queryFn`**, per
 * `UserManagement.queryError.test.tsx`: an infinite query's `isLoading` against
 * `refetchOnMount: "always"` is exactly the sort of thing a hand-written flag
 * would get wrong, and the retry has to be shown to actually recover.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnhancedPublicUser, Message, User } from "../../utils/types";
import MessageContent from "./MessageContent";
import { UserContext } from "../../utils/userContext";

/** Set per test: what the one page fetch does. */
let behaviour: () => Promise<unknown> = async () => ({
  messages: [],
  nextCursor: undefined,
});

const queryFn = jest.fn(() => behaviour());

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    realTimeQueryOptions: {},
    trpc: {
      useUtils: () => ({
        user: {
          messages: { getUnreadMessageCount: { invalidate: jest.fn() } },
          requests: { me: { invalidate: jest.fn() } },
        },
      }),
      user: {
        messages: {
          conversation: {
            useInfiniteQuery: (input: unknown, options: object) =>
              reactQuery.useInfiniteQuery({
                queryKey: ["conversation", input],
                queryFn: () => queryFn(),
                initialPageParam: undefined,
                ...options,
              }),
          },
          markMessagesAsRead: { useMutation: () => ({ mutate: jest.fn() }) },
        },
      },
    },
  };
});

jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: () => ({ bind: jest.fn(), unbind: jest.fn() }),
    unsubscribe: jest.fn(),
  }),
  releasePusherClient: jest.fn(),
}));

const CURRENT_USER = { id: "viewer" } as unknown as User;

/**
 * `message: ""` is the shape every modern row has, per the note above - the
 * opening text lives in the `Message` table, so the panel has nothing to render
 * from the request itself.
 */
const SELECTED_USER = {
  id: "other-1",
  incomingRequest: {
    id: "req-1",
    fromUserId: "other-1",
    message: "",
    dateCreated: new Date("2026-01-02T15:04:05Z"),
  },
} as unknown as EnhancedPublicUser;

const A_MESSAGE = {
  id: "msg-1",
  content: "Sounds good, see you at 8.",
  conversationId: "conv-1",
  userId: "other-1",
  dateCreated: new Date("2026-01-02T15:04:05Z"),
  isRead: true,
} as unknown as Message;

const renderThread = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UserContext.Provider value={CURRENT_USER}>
        <MessageContent selectedUser={SELECTED_USER} />
      </UserContext.Provider>
    </QueryClientProvider>,
  );

/** The three outputs, as the one string each is recognisable by. */
const spinner = () => screen.queryByText("Loading...");
const failure = () => screen.queryByRole("alert");
const emptyCopy = () => screen.queryByText(/No messages yet/);
const thread = () => screen.queryByText("Sounds good, see you at 8.");

beforeEach(() => {
  queryFn.mockClear();
  behaviour = async () => ({ messages: [], nextCursor: undefined });
});

describe("an open conversation, in each of its three states", () => {
  it("shows a spinner while the thread is still loading, and nothing else", () => {
    behaviour = () => new Promise(() => undefined);

    renderThread();

    expect(spinner()).toBeInTheDocument();
    expect(failure()).not.toBeInTheDocument();
    expect(emptyCopy()).not.toBeInTheDocument();
  });

  it("says so when the thread is genuinely empty, and shows no spinner", async () => {
    behaviour = async () => ({ messages: [], nextCursor: undefined });

    renderThread();

    // The state the panel previously could not express at all.
    await waitFor(() => expect(emptyCopy()).toBeInTheDocument());
    expect(spinner()).not.toBeInTheDocument();
    expect(failure()).not.toBeInTheDocument();
  });

  it("shows the failure treatment when the thread query fails", async () => {
    behaviour = async () => {
      throw new Error("INTERNAL_SERVER_ERROR");
    };

    renderThread();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not load this conversation.");
    expect(spinner()).not.toBeInTheDocument();
    // The distinction the ticket is about: a failure must not read as empty.
    expect(emptyCopy()).not.toBeInTheDocument();
  });

  it("recovers the conversation when retry is pressed", async () => {
    behaviour = async () => {
      throw new Error("boom");
    };

    renderThread();
    await screen.findByRole("alert");

    behaviour = async () => ({ messages: [A_MESSAGE], nextCursor: undefined });

    await act(async () => {
      screen.getByRole("button", { name: "Try again" }).click();
    });

    await waitFor(() => expect(thread()).toBeInTheDocument());
    expect(failure()).not.toBeInTheDocument();
    expect(emptyCopy()).not.toBeInTheDocument();
  });

  /**
   * The control, and the mutation test for all of the above: a panel that
   * rendered any one of the three states unconditionally would pass some of
   * these tests and fail this one.
   */
  it("control: renders the messages when there are some", async () => {
    behaviour = async () => ({ messages: [A_MESSAGE], nextCursor: undefined });

    renderThread();

    await waitFor(() => expect(thread()).toBeInTheDocument());
    expect(spinner()).not.toBeInTheDocument();
    expect(failure()).not.toBeInTheDocument();
    expect(emptyCopy()).not.toBeInTheDocument();
  });
});
