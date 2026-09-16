import { render, screen } from "@testing-library/react";
import MessageContent from "./MessageContent";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, Message, User } from "../../utils/types";

/**
 * The message bubble honours the newlines the composer already stores.
 *
 * **This file is the ticket (SCRUM-471).** A newline survives everywhere
 * except where it is read: `SendBar` sets `white-space: pre-wrap` on the
 * contentEditable, so Shift+Enter on desktop — and, after SCRUM-463, a plain
 * Enter on mobile — puts a literal `\n` into `messageContent`; `handleSend`
 * trims it and sends it; the mutation stores it in a `VARCHAR(255)`. The
 * bubble then set no `white-space` at all, so the initial `normal` collapsed
 * that newline into a space. Two lines in, one line out, with nothing
 * reporting a problem and no data lost.
 *
 * *What this cannot cover, and deliberately does not claim to.* jsdom does no
 * layout and resolves no `white-space`, so "the second line renders on its own
 * line" is not observable here — see `testing/viewport.ts` for the measured
 * list. The assertions below are therefore about the class that selects the
 * behaviour, as an explicit proxy for it. The rendered line count belongs in
 * SCRUM-264's Playwright suite; a jsdom test that claimed to check it would be
 * asserting nothing while looking like it asserted everything.
 *
 * The negative assertion earns its place. `pre-wrap` would also honour the
 * newline and so would pass any presence-only check, but it additionally
 * preserves runs of spaces — and this text arrives `trim()`-ed from a
 * contentEditable that accumulates incidental whitespace. `pre-line` is the
 * one that keeps line breaks *and* collapses spaces, so the test pins which
 * utility is present rather than merely that one is.
 */

const MULTILINE = "line one\nline two";

/**
 * Concatenated so Tailwind's scanner cannot read a candidate out of this file.
 * v4 scans the whole repository rather than `src/` alone, so writing these two
 * class names out in full here would ship both utilities as real CSS purely
 * because a test named them — the scan-boundary rule in `CLAUDE.md`. Neither
 * is used by any component, so both would be dead bytes in every bundle.
 *
 * The positive assertion needs no such treatment: `MessageContent` emits
 * `whitespace-pre-line` itself, so naming it changes nothing about the output.
 * Verified against the compiled CSS, not assumed.
 */
const PRE_WRAP = "whitespace-" + "pre-wrap";
const PRE = "whitespace-" + "pre";

/**
 * `mock`-prefixed because `jest.mock` is hoisted above every other statement
 * in the module, so its factory cannot close over an ordinary const. The
 * prefix is the documented escape hatch, and it keeps one typed fixture
 * instead of a copy inside the factory that could drift from this one.
 */
const mockFetchedMessage = {
  id: "msg-1",
  content: MULTILINE,
  conversationId: "conv-1",
  userId: "other-1",
  dateCreated: new Date("2026-01-02T15:04:05Z"),
  isRead: true,
} as unknown as Message;

/**
 * Hoisted to module scope so every render sees the *same* object.
 *
 * This is not tidiness. Returning a fresh literal from `useInfiniteQuery`
 * gives `data.pages` a new identity on each render, so the `fetchedMessages`
 * memo recomputes, so the merge effect at `MessageContent.tsx:89` calls
 * `setConversationMessages`, which renders again — an unbounded loop that
 * React only stops by throwing "Maximum update depth exceeded". The first
 * version of this file did exactly that and spun for 28 minutes before it was
 * killed, which looked for all the world like a slow suite rather than a
 * broken fixture.
 *
 * A stable reference is also the truthful stub: React Query keeps `data`
 * referentially equal between renders unless it actually refetched, which is
 * the invariant the component is written against.
 */
const mockThreadQuery = {
  data: { pages: [{ messages: [mockFetchedMessage] }] },
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
};

/** Likewise stable: a new `mutate` each render would retrigger the read effect. */
const mockMarkAsRead = { mutate: jest.fn() };

/**
 * Stable for the same reason. `onSuccess` is a `useCallback` keyed on these
 * two invalidators, so fresh ones each render would churn the mutation's
 * options object and, through it, the effect that marks messages read.
 */
const mockUtils = {
  user: {
    messages: { getUnreadMessageCount: { invalidate: jest.fn() } },
    requests: { me: { invalidate: jest.fn() } },
  },
};

/**
 * The thread's three tRPC calls, stubbed as the shapes the component consumes
 * rather than driven through a provider — the precedent is
 * `requestCardControls.test.tsx`. `conversation` is an infinite query, so the
 * data arrives as `pages`; the component reverses them, which one page makes
 * a no-op.
 */
jest.mock("../../utils/trpc", () => ({
  trpc: {
    // Each returns the same object every call. Dereferenced inside these
    // inner arrows rather than in the factory body, so they are read at render
    // time — after the consts have initialised, not during the require that
    // triggers the factory.
    useUtils: () => mockUtils,
    user: {
      messages: {
        conversation: { useInfiniteQuery: () => mockThreadQuery },
        markMessagesAsRead: { useMutation: () => mockMarkAsRead },
      },
    },
  },
}));

/**
 * A real `acquirePusherClient` opens a websocket and signs a private channel
 * through `/api/pusher/auth`. The subject here is a rendered class, so the
 * client is stubbed down to the methods the subscribe effect calls.
 */
jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: () => ({ bind: jest.fn(), unbind: jest.fn() }),
    unsubscribe: jest.fn(),
  }),
  releasePusherClient: jest.fn(),
}));

/**
 * `message` is empty on purpose. A request that carries one prepends a
 * synthetic "initial" bubble, which would put a second element in the tree and
 * make the query below ambiguous for no benefit to this ticket.
 */
const SELECTED_USER = {
  id: "other-1",
  preferredName: "Riley",
  incomingRequest: {
    id: "req-1",
    message: "",
    dateCreated: new Date("2026-01-02T15:00:00Z"),
    fromUserId: "other-1",
  },
} as unknown as EnhancedPublicUser;

/**
 * The id is `viewer`, and that is not a style choice.
 *
 * It was first written as the obvious abbreviation for "me" followed by a
 * digit — which is also the name of a real Tailwind utility, the
 * margin-inline-end scale. Tailwind v4 scans this file, so that fixture id
 * compiled into the production stylesheet as a live rule nobody wrote or
 * wanted; a selector-set diff of two builds caught it sitting next to the
 * intended `.whitespace-pre-line`.
 *
 * Note that this docblock cannot name the token either, for the same reason:
 * spelling it here would emit the rule just as effectively as using it. That
 * is the trap in `CLAUDE.md` — prose is scanned too, so a comment explaining
 * the problem can recreate it. Hence the description rather than the string.
 *
 * The scanner does not know or care that a value is an identifier in a test.
 * `other-1`, `msg-1`, `conv-1` and `req-1` are safe because no utility is
 * named for any of them.
 */
const CURRENT_USER = { id: "viewer" } as unknown as User;

const renderThread = () =>
  render(
    <UserContext.Provider value={CURRENT_USER}>
      <MessageContent selectedUser={SELECTED_USER} />
    </UserContext.Provider>,
  );

/**
 * The default normalizer collapses whitespace, which would make
 * `"line one\nline two"` and `"line one line two"` indistinguishable —
 * precisely the distinction under test. Matching on the raw string keeps them
 * apart, and is why this query would still find the bubble on the unfixed
 * code: the newline is in the DOM either way. Only CSS decides whether it is
 * drawn, which is what the class assertions stand in for.
 */
const bubble = () =>
  screen.getByText(MULTILINE, { normalizer: (text) => text });

describe("message bubble whitespace", () => {
  it("selects pre-line, so a stored newline is not collapsed", () => {
    renderThread();

    expect(bubble()).toHaveClass("whitespace-pre-line");
  });

  it("does not use pre-wrap, which would also preserve runs of spaces", () => {
    renderThread();

    expect(bubble()).not.toHaveClass(PRE_WRAP);
    expect(bubble()).not.toHaveClass(PRE);
  });

  it("leaves wrapping and the bubble's width caps untouched", () => {
    renderThread();

    // `break-words` is what wraps a long unbroken token; the width caps are
    // the narrow and wide halves of the bubble's geometry. None of the three is
    // this ticket's business, so all three are pinned against it.
    //
    // The 50% cap moved from the width-only `desktop:` screen to the message
    // panel's own height-gated one in SCRUM-489: at a 267px panel the cap does
    // not narrow the bubble, it wraps it to four lines, inside a conversation
    // box that had nothing to show them in. This assertion is why that change
    // had to be deliberate, which is the job it was written for.
    expect(bubble()).toHaveClass("break-words");
    expect(bubble()).toHaveClass("max-w-[85%]");
    expect(bubble()).toHaveClass("message-panel-tall:max-w-[50%]");
  });

  it("keeps the stored text intact, newline included", () => {
    renderThread();

    expect(bubble().textContent).toBe(MULTILINE);
  });
});
