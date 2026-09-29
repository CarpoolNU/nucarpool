import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MessagePanel from "./MessagePanel";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, User } from "../../utils/types";

/**
 * The Message/Map tab strip signalled the active tab by colour
 * alone - no `role="tab"`, no `aria-selected` - so both tabs announced
 * identically. Of the five segmented controls the accessibility sweep
 * covered, this is the one close enough to a real tablist to get full tab
 * semantics rather than `aria-pressed`.
 *
 * The header, message list and composer are stubbed out: the subject here is
 * the tab strip `MessagePanel` owns directly, and each child already has its
 * own test file exercising its own contract (`MessageHeader.test.tsx`,
 * `MessageContent.test.tsx`, `SendBar.test.tsx`).
 *
 * **That stubbing is why `MessagePanel.conversationSwitch.test.tsx` is a
 * separate file and must stay one.** It renders the real `MessageContent` and
 * `SendBar`, with Pusher and a real React Query behind them, because the defect
 * it covers lives inside `MessageContent`'s merge-by-id - stubbing that child
 * out would test nothing. A `jest.mock` is per module per file, so one file
 * cannot have `MessageContent` both stubbed and real. Reconciling the two
 * would mean giving up the shallow render here, which is what confines these
 * assertions to the tab strip.
 */

jest.mock("./MessageHeader", () => ({
  __esModule: true,
  default: () => <div data-testid="message-header" />,
}));

jest.mock("./MessageContent", () => ({
  __esModule: true,
  default: () => <div data-testid="message-content" />,
}));

jest.mock("./SendBar", () => ({
  __esModule: true,
  default: () => <div data-testid="send-bar" />,
}));

jest.mock("../../utils/requestHandlers", () => ({
  createRequestHandlers: () => ({
    handleAcceptRequest: jest.fn(),
    handleRejectRequest: jest.fn(),
    isMutating: false,
  }),
}));

const mockMutation = { mutate: jest.fn(), mutateAsync: jest.fn() };

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: { messages: { conversation: { invalidate: jest.fn() } } },
    }),
    user: {
      messages: { sendMessage: { useMutation: () => mockMutation } },
      emails: {
        sendMessageNotification: { useMutation: () => mockMutation },
        sendAcceptanceNotification: { useMutation: () => mockMutation },
      },
    },
  },
}));

const CURRENT_USER = { id: "viewer", role: "RIDER" } as unknown as User;

const SELECTED_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  role: "DRIVER",
  status: "ACTIVE",
} as unknown as EnhancedPublicUser;

const renderPanel = () =>
  render(
    <UserContext.Provider value={CURRENT_USER}>
      <MessagePanel
        selectedUser={SELECTED_USER}
        onMessageSent={() => undefined}
        onCloseConversation={() => undefined}
        onViewRouteClick={() => undefined}
      />
    </UserContext.Provider>,
  );

describe("MessagePanel tab strip accessible state", () => {
  it("exposes the two tabs inside a tablist", () => {
    renderPanel();

    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Message" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Map" })).toBeInTheDocument();
  });

  it("marks exactly the active tab as selected, and moves it on click", async () => {
    renderPanel();

    expect(screen.getByRole("tab", { name: "Message" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await userEvent.click(screen.getByRole("tab", { name: "Map" }));

    expect(screen.getByRole("tab", { name: "Message" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("tab", { name: "Map" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
