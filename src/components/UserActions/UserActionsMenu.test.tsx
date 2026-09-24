import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import UserActionsMenu from "./UserActionsMenu";
import { BLOCK_GROUP_MEMBER_MESSAGE } from "../../server/router/user/blocks";

/**
 * The overflow menu and the block confirmation (SCRUM-554).
 *
 * The server enforces what a block does. What this file pins is the client's
 * half: nothing is blocked without the confirm step, confirming sends exactly
 * the counterpart's id, a success refreshes every surface the block hides
 * someone from, and a refusal shows the server's own words.
 *
 * `trpc` is mocked as a shape, the precedent `ConnectCard.test.tsx` sets. The
 * options passed to `useMutation` are captured so a test can answer the
 * mutation the way the server would.
 */

const mockBlock = jest.fn();
const mockReport = jest.fn();
const mockMutationOptions: {
  onSuccess?: () => Promise<void>;
  onError?: (error: { message: string }) => void;
} = {};

const mockInvalidations = {
  blocks: jest.fn(),
  recommendations: jest.fn(),
  map: jest.fn(),
  favorites: jest.fn(),
  requests: jest.fn(),
  unread: jest.fn(),
  conversation: jest.fn(),
};

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: {
        blocks: { me: { invalidate: mockInvalidations.blocks } },
        recommendations: {
          me: { invalidate: mockInvalidations.recommendations },
        },
        favorites: { me: { invalidate: mockInvalidations.favorites } },
        requests: { me: { invalidate: mockInvalidations.requests } },
        messages: {
          getUnreadMessageCount: { invalidate: mockInvalidations.unread },
          conversation: { invalidate: mockInvalidations.conversation },
        },
      },
      mapbox: { geoJsonUserList: { invalidate: mockInvalidations.map } },
    }),
    user: {
      blocks: {
        block: {
          useMutation: (options: typeof mockMutationOptions) => {
            Object.assign(mockMutationOptions, options);
            return { mutate: mockBlock, isPending: false };
          },
        },
      },
      reports: {
        create: {
          useMutation: () => ({ mutate: mockReport, isPending: false }),
        },
      },
    },
  },
}));

// Built inside the factory, which `jest.mock` hoists above this module's own
// declarations, and read back through `jest.requireMock`.
jest.mock("react-toastify/unstyled", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const mockToast = jest.requireMock("react-toastify/unstyled").toast as {
  success: jest.Mock;
  error: jest.Mock;
};

// `MenuItems anchor` positions through Floating UI, which observes the
// trigger's size once the menu opens. jsdom has no `ResizeObserver`, and does
// no layout for one to report anyway, so an inert stand-in is enough.
(global as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  jest.clearAllMocks();
});

const renderMenu = (onBlocked = jest.fn()) => {
  render(
    <UserActionsMenu
      userId="user-taylor"
      userName="Taylor"
      onBlocked={onBlocked}
    />,
  );
  return { onBlocked, user: userEvent.setup() };
};

const openConfirm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    screen.getByRole("button", { name: "More actions for Taylor" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Block" }));
  return screen.findByRole("dialog", { name: "Block Taylor?" });
};

describe("UserActionsMenu", () => {
  it("names its trigger after the person, and shows no dialog until asked", () => {
    renderMenu();

    expect(
      screen.getByRole("button", { name: "More actions for Taylor" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers Block, and choosing it asks before doing anything", async () => {
    const { user } = renderMenu();

    await openConfirm(user);

    expect(mockBlock).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const { user, onBlocked } = renderMenu();

    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mockBlock).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("blocks exactly this person on confirm", async () => {
    const { user } = renderMenu();

    await openConfirm(user);
    await user.click(screen.getByRole("button", { name: "Block" }));

    expect(mockBlock).toHaveBeenCalledTimes(1);
    expect(mockBlock).toHaveBeenCalledWith({ userId: "user-taylor" });
  });

  it("refreshes every surface a block hides someone from, then calls onBlocked", async () => {
    const { user, onBlocked } = renderMenu();
    await openConfirm(user);

    await act(async () => {
      await mockMutationOptions.onSuccess?.();
    });

    // One assertion per cache, so a missing invalidation names itself.
    for (const [surface, invalidate] of Object.entries(mockInvalidations)) {
      expect({ surface, calls: invalidate.mock.calls.length }).toEqual({
        surface,
        calls: 1,
      });
    }
    expect(mockToast.success).toHaveBeenCalledWith("You blocked Taylor.");
    expect(onBlocked).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("shows the server's refusal and does not report a block", async () => {
    const { user, onBlocked } = renderMenu();
    await openConfirm(user);

    act(() => {
      mockMutationOptions.onError?.({ message: BLOCK_GROUP_MEMBER_MESSAGE });
    });

    expect(mockToast.error).toHaveBeenCalledWith(BLOCK_GROUP_MEMBER_MESSAGE);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(mockInvalidations.blocks).not.toHaveBeenCalled();
  });
});

describe("UserActionsMenu Report (SCRUM-555)", () => {
  const openReport = async (requestId?: string) => {
    render(
      <UserActionsMenu
        userId="user-taylor"
        userName="Taylor"
        requestId={requestId}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "More actions for Taylor" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Report" }));
    await screen.findByRole("dialog", { name: "Report Taylor" });
    return user;
  };

  it("opens the report form, and sends nothing until it is submitted", async () => {
    await openReport();

    expect(mockReport).not.toHaveBeenCalled();
    expect(mockBlock).not.toHaveBeenCalled();
  });

  it("reports from the conversation the menu sits on", async () => {
    const user = await openReport("req-1");

    await user.selectOptions(screen.getByLabelText("Reason"), "Harassment");
    await user.click(screen.getByRole("button", { name: "Report" }));

    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedUserId: "user-taylor",
        requestId: "req-1",
      }),
    );
  });

  it("starts with an empty form each time it is opened", async () => {
    const user = await openReport();
    await user.type(screen.getByLabelText("What happened? (optional)"), "abc");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    await user.click(
      screen.getByRole("button", { name: "More actions for Taylor" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Report" }));

    expect(
      await screen.findByLabelText("What happened? (optional)"),
    ).toHaveValue("");
  });
});
