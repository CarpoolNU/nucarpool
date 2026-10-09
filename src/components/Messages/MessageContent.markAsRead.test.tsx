/**
 * `MessageContent`: a failed `markMessagesAsRead` is retried, and a successful
 * one is not repeated.
 *
 * Its own file rather than a block in `MessageContent.test.tsx`, because that
 * suite declares `markMessagesAsRead` as `inertMutation` - a literal result
 * with spies inside it and no state machine. These tests need the real
 * mutation, so that `onSuccess` and `onError` fire on React Query's own
 * timeline, which is what the retry depends on.
 *
 * **The discriminating case is a thread that changes while the unread set does
 * not.** A single ref holding the last unread id list, advanced immediately
 * after `mutate` regardless of outcome and guarded on `isEqual` against
 * that list, would retry a failed id only by accident - whenever a *new
 * unread message* happens to arrive after the failure and changes the
 * list. It would never recover the case below: a message the viewer sent
 * themselves, which changes `allMessages` and leaves the unread set
 * byte-identical. Such a guard would see an equal list and do nothing, and
 * those messages would stay unread until the component remounts, with the
 * unread badge still counting them.
 */

import { render, screen, waitFor, act } from "@testing-library/react";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EnhancedPublicUser, Message, User } from "../../utils/types";
import MessageContent from "./MessageContent";
import { UserContext } from "../../utils/userContext";
import { trpcSpies } from "../../testing/trpcHarness";

/** Set per test: what the one `markMessagesAsRead` call does, by call index. */
let markBehaviour: (call: number) => Promise<unknown> = async () => undefined;
let markCalls = 0;

/**
 * The Pusher `sendMessage` callback the component binds, captured so a test
 * can deliver a message the way production does.
 *
 * Assigned from inside the mock factory's `bind`, which runs during the
 * component's effect - long after this `let` initialises. Reading it in the
 * factory *body* would hit the temporal dead zone; reading it inside a
 * function the factory returns does not. See `trpcHarness.ts`.
 */
let deliverMessage: ((data: { newMessage: Message }) => void) | undefined;

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock(
    {
      "user.messages.conversation": {
        infiniteQuery: () => ({
          messages: [
            {
              id: "unread-1",
              content: "Are you still driving Tuesday?",
              conversationId: "conv-1",
              userId: "other-1",
              dateCreated: new Date("2026-01-02T15:04:05Z"),
              isRead: false,
            },
          ],
          nextCursor: undefined,
        }),
      },
      "user.messages.markMessagesAsRead": {
        mutation: () => {
          markCalls += 1;
          return markBehaviour(markCalls);
        },
      },
      // Utils-only: the component invalidates both on success. Neither is the
      // subject, and the harness's default invalidate records and resolves.
      "user.messages.getUnreadMessageCount": {},
      "user.requests.me": {},
    },
    { realTimeQueryOptions: {} },
  ),
);

jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: () => ({
      bind: (event: string, callback: (data: any) => void) => {
        if (event === "sendMessage") {
          (globalThis as any).__deliver = callback;
        }
      },
      unbind: jest.fn(),
    }),
    unsubscribe: jest.fn(),
  }),
  releasePusherClient: jest.fn(),
}));

/**
 * `viewer`, not the obvious two-letter abbreviation followed by a digit -
 * that is also a real Tailwind utility name, and v4 scans this file, so the
 * fixture id would compile into the production stylesheet. Same reasoning as
 * the note in `MessageContent.test.tsx`.
 */
const CURRENT_USER = { id: "viewer" } as unknown as User;

const SELECTED_USER = {
  id: "other-1",
  incomingRequest: {
    id: "req-1",
    fromUserId: "other-1",
    // Empty, as every modern row is: the opening text is a `Message`.
    message: "",
    dateCreated: new Date("2026-01-02T15:04:05Z"),
  },
} as unknown as EnhancedPublicUser;

/**
 * A message the **viewer** sent.
 *
 * This is what makes the test discriminating: it lands in `allMessages`, so
 * the mark-as-read effect's inputs change, but `userId === user.id` keeps it
 * out of the unread set - which therefore stays exactly `["unread-1"]`.
 */
const OWN_REPLY = {
  id: "own-1",
  content: "Yes, 8am works.",
  conversationId: "conv-1",
  userId: "viewer",
  dateCreated: new Date("2026-01-02T16:00:00Z"),
  isRead: true,
} as unknown as Message;

const markSpy = () => trpcSpies("user.messages.markMessagesAsRead").mutationFn;

const renderThread = () =>
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <UserContext.Provider value={CURRENT_USER}>
          <MessageContent selectedUser={SELECTED_USER} />
        </UserContext.Provider>
      </QueryClientProvider>
    </StrictMode>,
  );

/**
 * Lets React Query's timers and promise callbacks run.
 *
 * A negative assertion on a mutation is vacuous without this: `mutate` is
 * asynchronous, so checking the spy synchronously passes with the guard
 * deleted. See `trpcHarness.ts`.
 */
const drain = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** Delivers a Pusher message the way the bound channel callback does. */
const sendOverPusher = async (message: Message) => {
  deliverMessage = (globalThis as any).__deliver;
  expect(deliverMessage).toBeDefined();
  await act(async () => {
    deliverMessage!({ newMessage: message });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  markCalls = 0;
  markBehaviour = async () => undefined;
  (globalThis as any).__deliver = undefined;
  markSpy().mockClear();
  // Silenced per-test rather than globally: `onError` logs, and the failing
  // case below is supposed to.
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("marking a thread's messages as read", () => {
  it("retries ids whose mutation failed, when the thread next changes", async () => {
    markBehaviour = async (call) => {
      if (call === 1) throw new Error("network down");
      return undefined;
    };

    renderThread();

    await waitFor(() =>
      expect(markSpy()).toHaveBeenCalledWith({ messageIds: ["unread-1"] }),
    );
    // One call, not two, despite StrictMode mounting the effect twice: the
    // in-flight set is what makes the second invocation a no-op.
    expect(markSpy()).toHaveBeenCalledTimes(1);

    // The thread changes; the unread set does not.
    await sendOverPusher(OWN_REPLY);
    expect(await screen.findByText("Yes, 8am works.")).toBeInTheDocument();

    // The failure is released rather than recorded as done, so the same id
    // goes out again.
    await waitFor(() => expect(markSpy()).toHaveBeenCalledTimes(2));
    expect(markSpy()).toHaveBeenNthCalledWith(2, { messageIds: ["unread-1"] });
  });

  it("does not resend ids a successful mutation already confirmed", async () => {
    markBehaviour = async () => undefined;

    renderThread();

    await waitFor(() =>
      expect(markSpy()).toHaveBeenCalledWith({ messageIds: ["unread-1"] }),
    );
    expect(markSpy()).toHaveBeenCalledTimes(1);

    // The same change as above, from the same starting unread set - so this is
    // the control that proves the retry is driven by the *outcome* and not
    // just by the thread changing. Without the confirmed set, the fix would
    // re-mark every unread id on every new message.
    await sendOverPusher(OWN_REPLY);
    expect(await screen.findByText("Yes, 8am works.")).toBeInTheDocument();
    await drain();

    expect(markSpy()).toHaveBeenCalledTimes(1);
  });
});
