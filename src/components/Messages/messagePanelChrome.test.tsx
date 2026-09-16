import { fireEvent, render, screen } from "@testing-library/react";
import MessageHeader from "./MessageHeader";
import MessageContent from "./MessageContent";
import SendBar from "./SendBar";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, Message, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";
import {
  DESKTOP_SCREEN_NAME,
  MESSAGE_PANEL_TALL_SCREEN_NAME,
} from "../../utils/breakpoints";

/**
 * The conversation panel asks for its full-size chrome only where there is
 * height for it.
 *
 * **This file is the ticket (SCRUM-489).** A landscape phone is 667px wide, so
 * it is above the width breakpoint and takes every desktop branch - into a
 * viewport 375px tall. The panel fills a row that is 91.5% of that, and the
 * full-size chrome took 198px of the 343 available: 145 of header, from `p-8`
 * around an 80px avatar, and a 53px tab strip. `SendBar` then would not shrink
 * below its min-content height, so the conversation was left with nothing but
 * its own padding - `contentHeight` 0, with a `scrollHeight` of 220 behind it -
 * and the send bar's last 18.38px went off the bottom of the screen. A user who
 * opened a thread in landscape could see who they were talking to, type and
 * send, and could not read a single message, including the one they had just
 * sent.
 *
 * The fix is one derived threshold, `MESSAGE_PANEL_MIN_HEIGHT_PX`, opted into
 * at three call sites. Its arithmetic is guarded in `breakpoints.test.ts`; its
 * geometry was measured in Chromium and is recorded on the
 * `message-panel-chrome` fixture. **What is left for this file is the wiring
 * between them**, which is the half that neither of the other two can see: a
 * threshold that is derived correctly and a geometry that was measured
 * correctly still ship a broken panel if a call site asks for the wrong
 * screen, and nothing else would fail.
 *
 * *What this cannot cover.* jsdom does no layout and resolves no media query -
 * see `testing/viewport.ts` for the measured list - so every assertion here is
 * about the class a component *requests*, as an explicit proxy for the box it
 * gets. `setViewportWidth` moves `useIsMobile`, which is a hook and therefore
 * observable; it does nothing whatsoever to a `min-height` media query, so
 * there is no "at a short viewport" case to write. The rendered geometry
 * belongs in SCRUM-264's Playwright suite at 667x375.
 *
 * **The variant prefixes below are composed from the screen constants rather
 * than written out.** Two reasons, and the first is the one that bites: these
 * are negative assertions against utilities that no longer exist anywhere in
 * the repository, and Tailwind v4 scans this file like any other - so spelling
 * `desktop` and the margin utility as one literal would ship the rule this test
 * exists to prove is gone. The second is that composing them makes a rename of
 * the screen fail here instead of silently orphaning every utility that names
 * it.
 */

const tall = (utility: string) =>
  `${MESSAGE_PANEL_TALL_SCREEN_NAME}:${utility}`;

const widthOnly = (utility: string) => `${DESKTOP_SCREEN_NAME}:${utility}`;

/**
 * The two utilities this file names that the app only ever uses *behind a
 * variant*, split so the scanner cannot read a candidate out of them.
 *
 * Composing the variant prefix is not enough on its own, and a selector-set
 * diff is what caught that: Tailwind reads a candidate out of the bare literal
 * passed to `tall()` just as happily as out of a class attribute, so the first
 * draft of this file shipped an unvariant rule for each of these two - two
 * rules in the production bundle that applied to nothing, present purely
 * because a test mentioned them. Note this docblock cannot spell either one
 * out either, for exactly the same reason, which is why they are described
 * rather than named.
 *
 * The other utilities asserted below (`px-2`, `py-1`, `h-14`, `h-20`, `mx-0`,
 * the 85% cap) are all used bare somewhere in the app already, so naming them
 * changes no output. These two are not.
 *
 * `MessageContent.whitespace.test.tsx` uses the same escape hatch, and its
 * docblock records the diff that first found this trap in a test fixture.
 */
const SIDE_INSET = "mx-" + "10";
const HALF_COLUMN_CAP = "max-w-" + "[50%]";

/**
 * Every class attribute in a rendered tree, as one string to search.
 *
 * `innerHTML` would be the obvious way to ask "does this tree mention that
 * utility anywhere", and the lint rule forbids reading it - for the reason it
 * states, and rightly, since a habit of reading markup as a string is how a
 * value ends up being assigned back as one. This is the narrower question
 * anyway: it looks at class attributes and nothing else, so a match cannot come
 * from a text node or an `aria-label` that happens to contain the same
 * substring.
 */
const classAttributes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("*"))
    .map((element) => element.getAttribute("class") ?? "")
    .join(" ");

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    // `true` so the header draws its placeholder box, which is a plain `div`
    // carrying the avatar's classes. The loaded and errored branches are an
    // `Image` and an icon component, and both would put the classes behind a
    // wrapper's rendering choices rather than on an element this test can read
    // directly. All three request the same string; `layoutFixtures.ts` guards
    // that they keep doing so.
    isLoading: true,
  }),
}));

/**
 * `MessageContent`'s three tRPC calls and its Pusher subscription, stubbed as
 * the shapes the component consumes - the recipe and the reasoning are
 * `MessageContent.whitespace.test.tsx`'s, including why every one of these
 * objects has to be stable across renders. A fresh literal per render gives
 * `data.pages` a new identity, the merge effect sets state, and the render
 * loops until React throws.
 */
const mockFetchedMessage = {
  id: "msg-1",
  content: "Sounds good, see you at 8.",
  conversationId: "conv-1",
  userId: "other-1",
  dateCreated: new Date("2026-01-02T15:04:05Z"),
  isRead: true,
} as unknown as Message;

const mockThreadQuery = {
  data: { pages: [{ messages: [mockFetchedMessage] }] },
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: jest.fn(),
};

const mockMarkAsRead = { mutate: jest.fn() };

const mockUtils = {
  user: {
    messages: { getUnreadMessageCount: { invalidate: jest.fn() } },
    requests: { me: { invalidate: jest.fn() } },
  },
};

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => mockUtils,
    user: {
      messages: {
        conversation: { useInfiniteQuery: () => mockThreadQuery },
        markMessagesAsRead: { useMutation: () => mockMarkAsRead },
      },
    },
  },
}));

jest.mock("../../utils/pusherClient", () => ({
  acquirePusherClient: () => ({
    subscribe: () => ({ bind: jest.fn(), unbind: jest.fn() }),
    unsubscribe: jest.fn(),
  }),
  releasePusherClient: jest.fn(),
}));

restoreViewportAfterEach();

/**
 * `id` is `viewer` and not the two-letter abbreviation for "me" followed by a
 * digit, which is also a real Tailwind utility. The scanner does not know a
 * value is a test fixture id - `MessageContent.whitespace.test.tsx` records the
 * selector-set diff that caught exactly that rule shipping.
 */
const CURRENT_USER = { id: "viewer" } as unknown as User;

const SELECTED_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  role: "DRIVER",
  status: "ACTIVE",
  incomingRequest: {
    id: "req-1",
    message: "",
    dateCreated: new Date("2026-01-02T15:00:00Z"),
    fromUserId: "other-1",
  },
} as unknown as EnhancedPublicUser;

const renderHeader = () =>
  render(
    <UserContext.Provider value={CURRENT_USER}>
      <MessageHeader
        selectedUser={SELECTED_USER}
        onAccept={() => undefined}
        onReject={() => undefined}
        onClose={() => undefined}
        groupId={null}
        isMutating={false}
      />
    </UserContext.Provider>,
  );

const renderContent = () =>
  render(
    <UserContext.Provider value={CURRENT_USER}>
      <MessageContent selectedUser={SELECTED_USER} />
    </UserContext.Provider>,
  );

describe("the desktop conversation header's chrome", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  /**
   * The compact values are the base and the full-size ones the override, which
   * is the inversion the repository's other two height screens use. Asserted
   * as *both* halves on one element: the override alone would leave a landscape
   * phone on `p-8`, and the base alone would take the full-size padding away
   * from every desktop.
   */
  it("asks for compact padding as its base and the full-size padding above the threshold", () => {
    const { container } = renderHeader();
    const header = container.firstElementChild;

    expect(header).not.toBeNull();
    expect(header).toHaveClass("px-2", "py-1", tall("p-8"));
  });

  /**
   * The avatar is the single largest block in the full-size header, and 56px is
   * the largest box that costs nothing: the close control beside the name is
   * already `h-14`, so the header's height does not fall below 56 plus its
   * padding however small the avatar gets. Shrinking it further would buy
   * nothing and lose a recognisable picture.
   */
  it("asks for a 56px avatar as its base and the 80px one above the threshold", () => {
    const { container } = renderHeader();
    const avatar = container.querySelector(".rounded-full");

    expect(avatar).not.toBeNull();
    expect(avatar).toHaveClass(
      "h-14",
      "w-14",
      tall("h-20"),
      tall("w-20"),
      "rounded-full",
    );
  });

  /**
   * The close control's size is load-bearing for the arithmetic above rather
   * than only for the tap target, so it is pinned here: if it shrinks, the
   * avatar and the padding stop being the terms that decide the header's
   * height and the threshold's header figure goes stale.
   */
  it("keeps the close control at the size the header's height is measured from", () => {
    renderHeader();

    expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
      "h-14",
      "w-14",
    );
  });

  /**
   * Tree shape, and the reason the header could take compact *base* classes at
   * all: the mobile arrangement returns before reaching them, so they are
   * unreachable from a phone in portrait however the media query is written.
   * This is what makes the header different from `SendBar` and
   * `MessageContent`, which are one tree on both platforms and therefore need
   * the screen's width term to protect mobile.
   */
  it("renders a different branch on mobile, which never reaches those classes", () => {
    setViewportWidth(MOBILE_WIDTH);

    const { container } = renderHeader();

    expect(container.firstElementChild?.className).not.toContain("py-1");
    expect(container.firstElementChild?.className).not.toContain(
      MESSAGE_PANEL_TALL_SCREEN_NAME,
    );
    // The control that only the mobile branch draws, as the positive half: a
    // negative assertion alone would also pass against a branch that rendered
    // nothing at all.
    expect(
      screen.getByRole("button", { name: "Back to conversations" }),
    ).toBeInTheDocument();
  });
});

describe("the send bar's composer inset", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  /**
   * 80px of horizontal margin on a row only as wide as the panel, which at
   * 667px wide left the composer 78px - and at that width `globals.css`'s
   * `.placeholder:empty:before` hint wrapped to three lines, making the bar
   * 131.5px tall instead of 97. A width term driving a height problem, which is
   * why it is gated on the panel's height and not on its own axis.
   */
  it("asks for the 40px inset only above the threshold", () => {
    const { container } = render(<SendBar onSendMessage={jest.fn()} />);
    const row = container.querySelector(".rounded-lg");

    expect(row).not.toBeNull();
    expect(row).toHaveClass("mx-0", tall(SIDE_INSET));
  });

  /**
   * The regression this replaces. Left on the width-only screen the inset
   * applied at every desktop width, including the 667px one where it cost the
   * conversation everything it had.
   */
  it("no longer asks for that inset on width alone", () => {
    const { container } = render(<SendBar onSendMessage={jest.fn()} />);

    expect(classAttributes(container)).not.toContain(widthOnly(SIDE_INSET));
  });

  /**
   * The counter sits under the box it counts, so it has to carry the row's
   * inset exactly. Left behind on the old screen it would hang 40px inboard of
   * that box on a landscape phone - a cosmetic tell that the two had been
   * changed independently.
   */
  it("keeps the character counter on the same inset as the row it belongs to", () => {
    const { container } = render(<SendBar onSendMessage={jest.fn()} />);
    const box = screen.getByRole("textbox", { name: "Message" });

    // The counter is rendered only for a non-empty box, which is what makes
    // this reachable at all.
    box.textContent = "hello";
    fireEvent.input(box);

    const counter = container.querySelector(".text-end");

    expect(counter).not.toBeNull();
    expect(counter).toHaveClass("mx-0", tall(SIDE_INSET));
    expect(counter?.className).not.toContain(widthOnly(SIDE_INSET));
  });
});

describe("the message bubble's width cap", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  /**
   * The cap does not widen a bubble on a narrow panel, it wraps it: the same
   * 26-character message measures 44px tall against a 1040px panel and 112px
   * against the 267px one a landscape phone gets. So it is a height term here,
   * and it falls back to the 85% the mobile tree already uses rather than to no
   * cap - a bubble spanning the full column loses the left-right asymmetry that
   * says who sent it.
   */
  it("asks for the 50% cap only above the threshold, falling back to 85%", () => {
    renderContent();
    const bubble = screen.getByText("Sounds good, see you at 8.");

    expect(bubble).toHaveClass(
      tall(HALF_COLUMN_CAP),
      "max-w-[85%]",
      "rounded-lg",
    );
  });

  it("no longer asks for the 50% cap on width alone", () => {
    renderContent();
    const bubble = screen.getByText("Sounds good, see you at 8.");

    expect(bubble.className).not.toContain(widthOnly(HALF_COLUMN_CAP));
  });
});

/**
 * All three call sites name the same screen.
 *
 * The failure this catches is a partial fix, which is the likely one: compact
 * the header, leave the send bar on the width-only screen, and the panel still
 * loses its conversation on a landscape phone while every other test here
 * passes. Asserting the three together is what makes them one decision rather
 * than three coincidences.
 */
describe("the three call sites", () => {
  it("opt into one threshold rather than three", () => {
    setViewportWidth(DESKTOP_WIDTH);

    const header = classAttributes(renderHeader().container);
    const sendBar = classAttributes(
      render(<SendBar onSendMessage={jest.fn()} />).container,
    );
    const content = classAttributes(renderContent().container);

    for (const classes of [header, sendBar, content]) {
      expect(classes).toContain(`${MESSAGE_PANEL_TALL_SCREEN_NAME}:`);
    }
  });
});
