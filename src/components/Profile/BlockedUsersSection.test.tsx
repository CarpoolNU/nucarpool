import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import BlockedUsersSection from "./BlockedUsersSection";

/**
 * The profile's blocked-users list (SCRUM-554).
 *
 * Pinned here: every state of the query reads as itself (loading, failed,
 * empty, a list), Unblock sends only that person's id, a success refreshes
 * what the block was hiding, and none of it can submit the profile form it
 * sits beside.
 */

type Entry = { userId: string; name: string; blockedAt: Date };

const mockQuery: {
  isPending: boolean;
  isError: boolean;
  data: Entry[] | undefined;
  refetch: jest.Mock;
} = { isPending: false, isError: false, data: [], refetch: jest.fn() };

const mockUnblock = jest.fn();
const mockUnblockOptions: {
  onSuccess?: (data: unknown, variables: { userId: string }) => Promise<void>;
} = {};
const mockInvalidate = jest.fn();

jest.mock("../../utils/trpc", () => {
  const invalidatable = () => ({ invalidate: mockInvalidate });
  return {
    trpc: {
      useUtils: () => ({
        user: {
          blocks: { me: invalidatable() },
          recommendations: { me: invalidatable() },
          favorites: { me: invalidatable() },
          requests: { me: invalidatable() },
          messages: {
            getUnreadMessageCount: invalidatable(),
            conversation: invalidatable(),
          },
        },
        mapbox: { geoJsonUserList: invalidatable() },
      }),
      user: {
        blocks: {
          me: { useQuery: () => mockQuery },
          unblock: {
            useMutation: (options: typeof mockUnblockOptions) => {
              Object.assign(mockUnblockOptions, options);
              return { mutate: mockUnblock, isPending: false };
            },
          },
        },
      },
    },
  };
});

jest.mock("react-toastify/unstyled", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));
const mockToast = jest.requireMock("react-toastify/unstyled").toast as {
  success: jest.Mock;
};

const TAYLOR = { userId: "user-taylor", name: "Taylor", blockedAt: new Date() };
const JORDAN = { userId: "user-jordan", name: "Jordan", blockedAt: new Date() };

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockQuery, { isPending: false, isError: false, data: [] });
});

describe("BlockedUsersSection", () => {
  it("says so when nobody is blocked", () => {
    render(<BlockedUsersSection />);

    expect(
      screen.getByRole("heading", { name: "Blocked Users" }),
    ).toBeInTheDocument();
    expect(screen.getByText("You haven't blocked anyone.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("reports a failed load as a failure with a retry, not as an empty list", async () => {
    Object.assign(mockQuery, { isError: true, data: undefined });
    render(<BlockedUsersSection />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.queryByText("You haven't blocked anyone."),
    ).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(mockQuery.refetch).toHaveBeenCalled();
  });

  it("lists each blocked person with their own Unblock", async () => {
    mockQuery.data = [TAYLOR, JORDAN];
    render(<BlockedUsersSection />);

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "TaylorUnblock",
      "JordanUnblock",
    ]);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Unblock Jordan" }));

    expect(mockUnblock).toHaveBeenCalledTimes(1);
    expect(mockUnblock).toHaveBeenCalledWith({ userId: JORDAN.userId });
  });

  it("refreshes what the block was hiding, and names who was unblocked", async () => {
    mockQuery.data = [TAYLOR];
    render(<BlockedUsersSection />);

    await act(async () => {
      await mockUnblockOptions.onSuccess?.(
        { blocked: false },
        { userId: TAYLOR.userId },
      );
    });

    // Seven caches, the list in `invalidateBlockCaches`.
    expect(mockInvalidate).toHaveBeenCalledTimes(7);
    expect(mockToast.success).toHaveBeenCalledWith("You unblocked Taylor.");
  });

  it("cannot submit a form it is rendered inside", async () => {
    // It sits beside the profile's react-hook-form. A default-typed button
    // would submit it, so an Unblock would also run Save Changes.
    mockQuery.data = [TAYLOR];
    const onSubmit = jest.fn((event: { preventDefault: () => void }) =>
      event.preventDefault(),
    );
    render(
      <form onSubmit={onSubmit}>
        <BlockedUsersSection />
      </form>,
    );

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Unblock Taylor" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(mockUnblock).toHaveBeenCalledTimes(1);
  });
});
