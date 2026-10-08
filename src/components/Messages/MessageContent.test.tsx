/**
 * `MessageContent`: which of three answers an open conversation gives, and how
 * a bubble treats the newlines it stores.
 *
 * Both `describe` blocks share this file because the mandatory split
 * reasons in `CLAUDE.md` do not apply; only an idiom difference separates
 * them. The whitespace block stubs `trpc` as a plain object returning a
 * hand-built `useInfiniteQuery` result, and that stub must be hoisted to
 * module scope so every render sees the *same* object - a fresh literal
 * would give `data.pages` a new identity each render, the `fetchedMessages`
 * memo would recompute, the merge effect would call
 * `setConversationMessages`, and the component would render again without
 * bound, spinning the suite forever while looking like a slow test rather
 * than a broken fixture.
 *
 * Both blocks go through `buildTrpcMock` and the real client, which removes
 * that hazard rather than working around it: React Query keeps `data`
 * referentially equal between renders unless it actually refetched, which is
 * the invariant the component is written against. The cost is that the
 * whitespace assertions await a resolving fetch instead of reading a
 * synchronous stub.
 *
 * ---
 *
 * That a conversation gives three different answers, not one.
 *
 * Rendering the message list unconditionally would make "nobody has
 * written anything", "still loading" and "the request failed" one
 * pixel-identical empty white panel - with `SendBar` live above it,
 * offering to add to a conversation that might not have loaded. The
 * `QueryError` docstring names this as the worst failure mode a matching
 * product has: "silent empty lists made a real outage look like nobody was
 * using the app".
 *
 * **All three states are asserted in this one file deliberately.** The
 * distinction is the deliverable, and a file that only pinned the failure case
 * would let it collapse back to two. Each test additionally asserts the
 * *absence* of the other two outputs, so no pair of states can quietly
 * become the same again.
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

jest.mock("../../utils/trpc", () =>
  require("../../testing/trpcHarness").buildTrpcMock(
    {
      "user.messages.conversation": { infiniteQuery: () => queryFn() },
      "user.messages.markMessagesAsRead": { inertMutation: true },
      // Utils-only: the component invalidates both, and neither is the
      // subject. The harness's default invalidate records and resolves.
      "user.messages.getUnreadMessageCount": {},
      "user.requests.me": {},
    },
    { realTimeQueryOptions: {} },
  ),
);

jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: () => ({ bind: jest.fn(), unbind: jest.fn() }),
    unsubscribe: jest.fn(),
  }),
  releasePusherClient: jest.fn(),
}));

/**
 * The multiline body the second block is about. A newline survives everywhere
 * except where it is read: `SendBar` sets `white-space: pre-wrap` on the
 * contentEditable, so Shift+Enter on desktop - and, after mobile gained the
 * same handling, a plain Enter on mobile - puts a literal `\n` into
 * `messageContent`; `handleSend` trims it and sends it; the mutation stores it
 * in a `VARCHAR(255)`. The bubble then set no `white-space` at all, so the
 * initial `normal` collapsed that newline into a space. Two lines in, one line
 * out, with nothing reporting a problem and no data lost.
 */
const MULTILINE = "line one\nline two";

/**
 * Concatenated so Tailwind's scanner cannot read a candidate out of this file.
 * v4 scans the whole repository rather than `src/` alone, so writing these two
 * class names out in full here would ship both utilities as real CSS purely
 * because a test named them - the scan-boundary rule in `CLAUDE.md`. Neither
 * is used by any component, so both would be dead bytes in every bundle.
 *
 * The positive assertion needs no such treatment: `MessageContent` emits
 * `whitespace-pre-line` itself, so naming it changes nothing about the output.
 * Verified against the compiled CSS, not assumed.
 */
const PRE_WRAP = "whitespace-" + "pre-wrap";
const PRE = "whitespace-" + "pre";

/**
 * The id is `viewer`, and that is not a style choice.
 *
 * The obvious abbreviation for "me" followed by a digit is also the name
 * of a real Tailwind utility, the margin-inline-end scale - and Tailwind
 * v4 scans this file, so that id would compile into the production
 * stylesheet as a live rule nobody wrote or wanted, sitting next to the
 * intended `.whitespace-pre-line` in a selector-set diff.
 *
 * Note that this docblock cannot name the token either, for the same reason:
 * spelling it here would emit the rule just as effectively as using it. That
 * is the trap in `CLAUDE.md` - prose is scanned too, so a comment explaining
 * the problem can recreate it. Hence the description rather than the string.
 *
 * The scanner does not know or care that a value is an identifier in a test.
 * `other-1`, `msg-1`, `conv-1` and `req-1` are safe because no utility is
 * named for any of them.
 */
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

/** The same row, carrying the newline the second block is about. */
const MULTILINE_MESSAGE = {
  ...A_MESSAGE,
  content: MULTILINE,
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

    // The state an unconditional message list could not express at all.
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

  /**
   * `messages.conversation` throws `FORBIDDEN` for a blocked pair,
   * and that refusal never clears by retrying. Shaped like a real
   * `TRPCClientError` — `data.code` is what `isBlocked` and
   * `NON_RETRYABLE_CODES` both read — rather than a plain `Error`, which is
   * exactly what the "other failure modes" case above already covers.
   */
  it("shows a plain unavailable message, with no Retry, for a blocked FORBIDDEN", async () => {
    behaviour = async () => {
      throw Object.assign(new Error("This user isn't available."), {
        data: { code: "FORBIDDEN" },
      });
    };

    renderThread();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("This user isn't available.");
    expect(status).not.toHaveTextContent("problem on our side");
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    expect(failure()).not.toBeInTheDocument();
    expect(spinner()).not.toBeInTheDocument();
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

/**
 * The message bubble honours the newlines the composer already stores.
 *
 * *What this cannot cover, and deliberately does not claim to.* jsdom does no
 * layout and resolves no `white-space`, so "the second line renders on its own
 * line" is not observable here - see `testing/viewport.ts` for the measured
 * list. The assertions below are therefore about the class that selects the
 * behaviour, as an explicit proxy for it. The rendered line count belongs in
 * the project's Playwright suite; a jsdom test that claimed to check it would
 * be asserting nothing while looking like it asserted everything.
 *
 * The negative assertion earns its place. `pre-wrap` would also honour the
 * newline and so would pass any presence-only check, but it additionally
 * preserves runs of spaces - and this text arrives `trim()`-ed from a
 * contentEditable that accumulates incidental whitespace. `pre-line` is the
 * one that keeps line breaks *and* collapses spaces, so the test pins which
 * utility is present rather than merely that one is.
 */
describe("message bubble whitespace", () => {
  /**
   * Opens a thread holding the multiline row and hands back its bubble.
   *
   * The default normalizer collapses whitespace, which would make
   * `"line one\nline two"` and `"line one line two"` indistinguishable -
   * precisely the distinction under test. Matching on the raw string keeps them
   * apart, and is why this query would still find the bubble on the unfixed
   * code: the newline is in the DOM either way. Only CSS decides whether it is
   * drawn, which is what the class assertions stand in for.
   */
  const openMultilineThread = () => {
    behaviour = async () => ({
      messages: [MULTILINE_MESSAGE],
      nextCursor: undefined,
    });

    renderThread();

    return screen.findByText(MULTILINE, { normalizer: (text) => text });
  };

  it("selects pre-line, so a stored newline is not collapsed", async () => {
    expect(await openMultilineThread()).toHaveClass("whitespace-pre-line");
  });

  it("does not use pre-wrap, which would also preserve runs of spaces", async () => {
    const bubble = await openMultilineThread();

    expect(bubble).not.toHaveClass(PRE_WRAP);
    expect(bubble).not.toHaveClass(PRE);
  });

  it("leaves wrapping and the bubble's width caps untouched", async () => {
    const bubble = await openMultilineThread();

    // `break-words` is what wraps a long unbroken token; the width caps are
    // the narrow and wide halves of the bubble's geometry. None of the three is
    // this ticket's business, so all three are pinned against it.
    //
    // The 50% cap is gated on the message panel's own height, not the
    // width-only `desktop:` screen: at a 267px panel the cap does
    // not narrow the bubble, it wraps it to four lines, inside a conversation
    // box with nothing to show them in. This assertion pins that gating as
    // deliberate.
    expect(bubble).toHaveClass("break-words");
    expect(bubble).toHaveClass("max-w-[85%]");
    expect(bubble).toHaveClass("message-panel-tall:max-w-[50%]");
  });

  it("keeps the stored text intact, newline included", async () => {
    expect((await openMultilineThread()).textContent).toBe(MULTILINE);
  });
});
