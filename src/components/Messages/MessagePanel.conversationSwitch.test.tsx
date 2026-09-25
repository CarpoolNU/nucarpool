/**
 * SCRUM-558: switching conversations on desktop must not carry one
 * conversation's state into the next.
 *
 * The Requests sidebar stays beside the open panel on desktop, so a click on a
 * second card re-renders `MessagePanel` with a new `selectedUser` rather than
 * mounting a fresh one. RTL's `rerender` is that shape exactly - the same root,
 * re-rendered - which is why every case below goes through it and none through
 * a second `render`. A second `render` would mount a new tree and pass against
 * the unfixed code.
 *
 * The real `MessageContent` and `SendBar` are rendered, on real React Query
 * with a stubbed `queryFn` per request, following
 * `sendMessageThreadRefresh.test.tsx`: the first defect lives in
 * `MessageContent`'s merge-by-id, so stubbing it out would test nothing.
 * `MessageHeader` is stubbed; it has its own suites.
 *
 * The last block is the other half of the key's contract. The key is the
 * request, not the `selectedUser` object, because a send refetches
 * `user.requests.me` and rebuilds that object for the same conversation. Keyed
 * on identity, the panel would remount after every send and lose whatever had
 * only arrived over Pusher.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessagePanel from "./MessagePanel";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, Message, User } from "../../utils/types";
import { conversationChannel } from "../../utils/pusherChannels";

const CURRENT_USER_ID = "me";

/** The server: each request's stored thread. */
const storedThreads: Record<string, Message[]> = {};

const sendMessageFn = jest.fn(
  async (_variables: { requestId: string; content: string }) => ({}),
);

/** The live `sendMessage` handler per Pusher channel, so a test can fire one. */
const pusherHandlers: Record<string, (data: { newMessage: Message }) => void> =
  {};

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");

  const inertMutation = () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
  });

  return {
    realTimeQueryOptions: {},
    trpc: {
      useUtils: () => ({
        user: {
          me: { invalidate: jest.fn() },
          requests: { me: { invalidate: jest.fn() } },
          recommendations: { me: { invalidate: jest.fn() } },
          groups: { me: { invalidate: jest.fn() } },
          messages: {
            getUnreadMessageCount: { invalidate: jest.fn() },
            conversation: { invalidate: jest.fn() },
          },
        },
      }),
      user: {
        messages: {
          conversation: {
            useInfiniteQuery: (input: { requestId: string }, options: object) =>
              reactQuery.useInfiniteQuery({
                queryKey: ["conversation", input],
                queryFn: async () => ({
                  messages: [...(storedThreads[input.requestId] ?? [])],
                  nextCursor: undefined,
                }),
                initialPageParam: undefined,
                ...options,
              }),
          },
          sendMessage: {
            useMutation: (options: object) =>
              reactQuery.useMutation({
                mutationFn: sendMessageFn,
                ...options,
              }),
          },
          markMessagesAsRead: { useMutation: inertMutation },
        },
        emails: {
          sendMessageNotification: { useMutation: inertMutation },
          sendAcceptanceNotification: { useMutation: inertMutation },
        },
        requests: { delete: { useMutation: inertMutation } },
        groups: {
          edit: { useMutation: inertMutation },
          create: { useMutation: inertMutation },
        },
      },
    },
  };
});

jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: (channelName: string) => ({
      bind: (
        event: string,
        handler: (data: { newMessage: Message }) => void,
      ) => {
        if (event === "sendMessage") pusherHandlers[channelName] = handler;
      },
      unbind: jest.fn(),
    }),
    unsubscribe: jest.fn(),
  }),
  releasePusherClient: jest.fn(),
}));

jest.mock("./MessageHeader", () => ({ __esModule: true, default: () => null }));

jest.mock("react-toastify/unstyled", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const CURRENT_USER = {
  id: CURRENT_USER_ID,
  carpoolId: null,
  role: "DRIVER",
} as unknown as User;

const person = (userId: string, requestId: string) =>
  ({
    id: userId,
    incomingRequest: {
      id: requestId,
      fromUserId: userId,
      message: "",
      dateCreated: new Date("2026-01-02T15:04:05Z"),
      conversation: { messages: [] },
    },
  }) as unknown as EnhancedPublicUser;

const message = (id: string, userId: string, content: string) =>
  ({
    id,
    content,
    conversationId: `conv-${userId}`,
    userId,
    dateCreated: new Date("2026-01-02T15:04:05Z"),
    isRead: true,
  }) as unknown as Message;

const ALICE = person("alice", "req-alice");
const BOB = person("bob", "req-bob");

const ALICE_SAYS = "Alice here - pickup at 8?";
const BOB_SAYS = "Bob here - I leave at 7:30.";

const onViewRouteClick = jest.fn();
const onMessageSent = jest.fn();

const panelFor = (selectedUser: EnhancedPublicUser, client: QueryClient) => (
  <QueryClientProvider client={client}>
    <UserContext.Provider value={CURRENT_USER}>
      <MessagePanel
        selectedUser={selectedUser}
        onMessageSent={onMessageSent}
        onCloseConversation={jest.fn()}
        onViewRouteClick={onViewRouteClick}
      />
    </UserContext.Provider>
  </QueryClientProvider>
);

/** Opens `first`, and returns a switch that re-renders the same root. */
const openConversation = (first: EnhancedPublicUser) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { rerender } = render(panelFor(first, client));
  return (next: EnhancedPublicUser) => rerender(panelFor(next, client));
};

const composer = () => screen.getByRole("textbox", { name: "Message" });

const typeDraft = (content: string) => {
  composer().textContent = content;
  fireEvent.input(composer());
};

beforeEach(() => {
  storedThreads["req-alice"] = [message("a-1", "alice", ALICE_SAYS)];
  storedThreads["req-bob"] = [message("b-1", "bob", BOB_SAYS)];
  for (const channel of Object.keys(pusherHandlers)) {
    delete pusherHandlers[channel];
  }
  sendMessageFn.mockClear();
  onViewRouteClick.mockClear();
  onMessageSent.mockClear();
});

describe("switching from one open conversation to another", () => {
  it("shows only the new conversation's messages", async () => {
    const switchTo = openConversation(ALICE);
    await screen.findByText(ALICE_SAYS);

    switchTo(BOB);

    expect(await screen.findByText(BOB_SAYS)).toBeInTheDocument();
    expect(screen.queryByText(ALICE_SAYS)).not.toBeInTheDocument();
  });

  it("leaves the first conversation's draft behind, and does not send it", async () => {
    const switchTo = openConversation(ALICE);
    await screen.findByText(ALICE_SAYS);
    typeDraft("Only meant for Alice");

    switchTo(BOB);
    await screen.findByText(BOB_SAYS);

    expect(composer()).toHaveTextContent("");
    // The character counter renders only while the draft state is non-empty,
    // so this is the state half of the composer, not just its DOM text.
    expect(screen.queryByText(/\/255$/)).not.toBeInTheDocument();

    // And the harm itself: Send in Bob's conversation carries nothing to Bob.
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(sendMessageFn).not.toHaveBeenCalled();
  });

  it("stays on the Map tab and draws the new person's route", async () => {
    const switchTo = openConversation(ALICE);
    fireEvent.click(screen.getByRole("tab", { name: "Map" }));
    expect(onViewRouteClick).toHaveBeenLastCalledWith(CURRENT_USER, ALICE);

    switchTo(BOB);

    expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(onViewRouteClick).toHaveBeenLastCalledWith(CURRENT_USER, BOB);
  });
});

describe("a send still in flight when the conversation switches", () => {
  it("lands in the conversation it was sent from, and reports that one", async () => {
    // Why `index.tsx`'s `handleMessageSent` no longer selects the id it is
    // given. A mutation's own `onSuccess` outlives its component, so this call
    // comes from Alice's unmounted panel after Bob's is open; selecting on it
    // switched the page back to Alice.
    let land = () => {};
    sendMessageFn.mockImplementationOnce(
      () => new Promise((resolve) => (land = () => resolve({}))),
    );

    const switchTo = openConversation(ALICE);
    await screen.findByText(ALICE_SAYS);
    typeDraft("See you at 8");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(sendMessageFn).toHaveBeenCalledTimes(1));

    switchTo(BOB);
    await screen.findByText(BOB_SAYS);
    await act(async () => land());

    // The first argument only: v5 passes `mutationFn` a context second.
    expect(sendMessageFn.mock.calls[0][0]).toEqual({
      requestId: "req-alice",
      content: "See you at 8",
    });
    await waitFor(() => expect(onMessageSent).toHaveBeenCalledWith("alice"));
  });
});

describe("re-rendering the same conversation", () => {
  it("keeps a Pusher-only message and the draft when selectedUser is rebuilt", async () => {
    const switchTo = openConversation(ALICE);
    await screen.findByText(ALICE_SAYS);

    const liveOnly = "Sent while you were reading";
    act(() => {
      pusherHandlers[conversationChannel("req-alice")]({
        newMessage: message("a-2", "alice", liveOnly),
      });
    });
    expect(screen.getByText(liveOnly)).toBeInTheDocument();
    typeDraft("Half typed");

    // What `user.requests.me` refetching does: a new object for the same
    // person and the same request.
    switchTo(person("alice", "req-alice"));

    expect(screen.getByText(liveOnly)).toBeInTheDocument();
    expect(composer()).toHaveTextContent("Half typed");
  });
});
