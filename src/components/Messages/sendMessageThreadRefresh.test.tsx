/**
 * SCRUM-510 finding 1: a sent message has to reach the thread it was sent to
 * even when the Pusher echo never arrives.
 *
 * `sendMessage`'s `onSuccess` invalidated `user.requests.me` and nothing else,
 * so the only thing that put the sender's *own* message into the open
 * conversation was the real-time echo. The server treats that delivery as
 * best-effort - `message.ts` catches a trigger failure, logs it, and returns
 * success because the row was saved - so a Pusher outage or a refused
 * private-channel subscription produced a send that reported success, cleared
 * the box, updated the sidebar card's preview (that query *was* invalidated)
 * and left the conversation unchanged. The user saw their message quoted in
 * the list and missing from the thread, and sent it again.
 *
 * **The echo is suppressed entirely here, and that is the point.** The happy
 * path passes either way, because the echo puts the message on screen whether
 * or not anything was invalidated - a test that let it through would go green
 * against the unfixed code. `acquirePusherClient` below returns a channel whose
 * `bind` records nothing and never fires, which is the shape of the failure the
 * fix is for.
 *
 * **Real React Query with a stubbed `queryFn`**, per
 * `MessageContent.threadStates.test.tsx` and `recommendationsQueryGate.test.tsx`:
 * what has to be established is that a *fetch went out and its result reached
 * the list*, and a hand-rolled spy on `invalidate` cannot tell an invalidation
 * that refetched from one that did not. `storedMessages` is the server, the
 * send mutation appends to it, and the assertion is the rendered thread.
 *
 * The control at the bottom holds everything else fixed and only stops the
 * invalidation reaching the cache, so the positive test above it is a
 * measurement rather than a coincidence of the harness.
 *
 * `MessageHeader` is stubbed out. It owns the accept/reject controls and an
 * avatar request, none of which bear on whether a sent message lands in the
 * thread, and it has its own suites.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MessagePanel from "./MessagePanel";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, Message, User } from "../../utils/types";

const CURRENT_USER_ID = "me";

/** The stored conversation. The send mutation below appends to it. */
let storedMessages: Message[] = [];

/**
 * Whether the component's `user.messages.conversation` invalidation reaches
 * React Query. Always true except in the control case, which is what makes the
 * control a change to one variable rather than to the harness.
 */
let invalidationReachesCache = true;

const conversationQueryFn = jest.fn(async () => ({
  messages: [...storedMessages],
  nextCursor: undefined as string | undefined,
}));

const sendMessageFn = jest.fn(
  async ({ content }: { requestId: string; content: string }) => {
    const stored = {
      id: `msg-${storedMessages.length + 1}`,
      content,
      conversationId: "conv-1",
      userId: CURRENT_USER_ID,
      dateCreated: new Date("2026-01-02T15:05:00Z"),
      isRead: true,
    } as unknown as Message;
    storedMessages = [...storedMessages, stored];
    return stored;
  },
);

/**
 * The tRPC surface `MessagePanel` and its children touch, as the React Query
 * calls they compile down to.
 *
 * Only `conversation` and `sendMessage` are real. The rest are the mutations
 * the panel constructs on every render - the accept/reject handlers and the two
 * notification emails - which never run in these tests but must exist for the
 * component to mount.
 */
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
      useUtils: () => {
        const queryClient = reactQuery.useQueryClient();
        return {
          user: {
            me: { invalidate: jest.fn() },
            requests: { me: { invalidate: jest.fn() } },
            recommendations: { me: { invalidate: jest.fn() } },
            groups: { me: { invalidate: jest.fn() } },
            messages: {
              getUnreadMessageCount: { invalidate: jest.fn() },
              conversation: {
                invalidate: () =>
                  invalidationReachesCache
                    ? queryClient.invalidateQueries({
                        queryKey: ["conversation"],
                      })
                    : Promise.resolve(),
              },
            },
          },
        };
      },
      user: {
        messages: {
          conversation: {
            useInfiniteQuery: (input: unknown, options: object) =>
              reactQuery.useInfiniteQuery({
                queryKey: ["conversation", input],
                queryFn: () => conversationQueryFn(),
                initialPageParam: undefined,
                ...options,
              }),
          },
          sendMessage: {
            useMutation: (options: object) =>
              reactQuery.useMutation({
                mutationFn: (variables: {
                  requestId: string;
                  content: string;
                }) => sendMessageFn(variables),
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

/** The echo that never arrives. `bind` is registered and never invoked. */
jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: () => ({ bind: jest.fn(), unbind: jest.fn() }),
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

/**
 * `message: ""` is the shape every modern row has - `requests.create` stores
 * the opening text as a `Message`, not on the request - so the thread renders
 * entirely from the query.
 */
const SELECTED_USER = {
  id: "other-1",
  incomingRequest: {
    id: "req-1",
    fromUserId: "other-1",
    message: "",
    dateCreated: new Date("2026-01-02T15:04:05Z"),
    conversation: { messages: [] },
  },
} as unknown as EnhancedPublicUser;

const THEIR_MESSAGE = {
  id: "msg-0",
  content: "Are you still driving Tuesday?",
  conversationId: "conv-1",
  userId: "other-1",
  dateCreated: new Date("2026-01-02T15:04:05Z"),
  isRead: true,
} as unknown as Message;

/**
 * The sidebar's half of the same success. `index.tsx` hangs
 * `user.requests.me`'s invalidation off this, and that query is what draws the
 * card preview - so the two halves disagreeing is what produced the original
 * symptom: the message quoted in the list and missing from the thread.
 */
const onMessageSent = jest.fn();

const renderPanel = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <UserContext.Provider value={CURRENT_USER}>
        <MessagePanel
          selectedUser={SELECTED_USER}
          onMessageSent={onMessageSent}
          onCloseConversation={jest.fn()}
          onViewRouteClick={jest.fn()}
        />
      </UserContext.Provider>
    </QueryClientProvider>,
  );

/** Compose and send, the way the composer is actually driven. */
const send = (content: string) => {
  const composer = screen.getByRole("textbox", { name: "Message" });
  composer.textContent = content;
  fireEvent.input(composer);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
};

beforeEach(() => {
  storedMessages = [THEIR_MESSAGE];
  invalidationReachesCache = true;
  conversationQueryFn.mockClear();
  sendMessageFn.mockClear();
  onMessageSent.mockClear();
});

describe("a message sent while the real-time echo is down", () => {
  it("appears in the open conversation", async () => {
    renderPanel();
    await screen.findByText("Are you still driving Tuesday?");

    send("Yes, 8am as usual.");

    await waitFor(() =>
      expect(sendMessageFn).toHaveBeenCalledWith({
        requestId: "req-1",
        content: "Yes, 8am as usual.",
      }),
    );

    expect(await screen.findByText("Yes, 8am as usual.")).toBeInTheDocument();

    // And the sidebar's half of the same success, so the card preview and the
    // thread cannot disagree about whether the message exists. Both now hang
    // off one `onSuccess`; the defect was that only this one did.
    expect(onMessageSent).toHaveBeenCalledWith("other-1");
  });

  it("is stored by the server either way, so the control is the cache", async () => {
    // The pre-fix shape, measured in the same harness: everything happens
    // except the invalidation reaching React Query. The row is written, the
    // sidebar's own query is invalidated, the box clears - and the thread the
    // user is looking at never changes. Without this, the test above could
    // pass on a refetch the harness caused rather than one the component asked
    // for.
    invalidationReachesCache = false;

    renderPanel();
    await screen.findByText("Are you still driving Tuesday?");

    send("Yes, 8am as usual.");

    await waitFor(() => expect(sendMessageFn).toHaveBeenCalledTimes(1));
    expect(storedMessages).toHaveLength(2);

    // Nothing else refetches: the global policy sets `refetchOnMount: false`
    // and `refetchOnWindowFocus: false`, and this thread stays open.
    expect(conversationQueryFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Yes, 8am as usual.")).not.toBeInTheDocument();
  });
});
