import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import ReportDialog from "./ReportDialog";
import { BLOCK_GROUP_MEMBER_MESSAGE } from "../../server/router/user/blocks";
import { DUPLICATE_REPORT_MESSAGE } from "../../server/router/user/reports";
import {
  REPORT_REASON_LABELS,
  REPORT_SNAPSHOT_MESSAGE_LIMIT,
} from "../../utils/reports";
import { REPORT_MESSAGE_MAX_LENGTH } from "../../utils/textLimits";

/**
 * The report form (SCRUM-555).
 *
 * The server decides what a report may contain and whether its block goes
 * through. What this file pins is the client's half: nothing is sent without
 * a reason, the input carries exactly what the form shows, "Also block" is on
 * unless unticked, and each server answer is reported the way the dialog
 * promises.
 *
 * `trpc` is mocked as a shape, as in `UserActionsMenu.test.tsx`, with the
 * mutation options captured so a test can answer the way the server would.
 */

const mockReport = jest.fn();
const mockMutationOptions: {
  onSuccess?: (result: {
    reportId: string;
    blocked: boolean;
    blockRefusal: string | null;
  }) => Promise<void>;
  onError?: (error: { message: string }) => void;
} = {};

const mockInvalidate = jest.fn();

jest.mock("../../utils/trpc", () => {
  const invalidator = {
    invalidate: (...args: unknown[]) => mockInvalidate(...args),
  };
  return {
    trpc: {
      useUtils: () => ({
        user: {
          blocks: { me: invalidator },
          recommendations: { me: invalidator },
          favorites: { me: invalidator },
          requests: { me: invalidator },
          messages: {
            getUnreadMessageCount: invalidator,
            conversation: invalidator,
          },
        },
        mapbox: { geoJsonUserList: invalidator },
      }),
      user: {
        reports: {
          create: {
            useMutation: (options: typeof mockMutationOptions) => {
              Object.assign(mockMutationOptions, options);
              return { mutate: mockReport, isPending: false };
            },
          },
        },
      },
    },
  };
});

jest.mock("react-toastify/unstyled", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
const mockToast = jest.requireMock("react-toastify/unstyled").toast as {
  success: jest.Mock;
  error: jest.Mock;
  info: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

const renderDialog = (requestId?: string) => {
  const onClose = jest.fn();
  const onBlocked = jest.fn();
  render(
    <ReportDialog
      userId="user-taylor"
      userName="Taylor"
      requestId={requestId}
      onClose={onClose}
      onBlocked={onBlocked}
    />,
  );
  return { onClose, onBlocked, user: userEvent.setup() };
};

const reportButton = () => screen.getByRole("button", { name: "Report" });

describe("ReportDialog", () => {
  it("names the person, and sends nothing until a reason is chosen", async () => {
    const { user } = renderDialog();

    expect(
      screen.getByRole("dialog", { name: "Report Taylor" }),
    ).toBeInTheDocument();
    expect(reportButton()).toBeDisabled();

    await user.click(reportButton());
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("sends the reason, the trimmed message and Also block, on by default", async () => {
    const { user } = renderDialog();

    await user.selectOptions(
      screen.getByLabelText("Reason"),
      REPORT_REASON_LABELS.HARASSMENT,
    );
    await user.type(
      screen.getByLabelText("What happened? (optional)"),
      "  Kept messaging.  ",
    );
    expect(
      screen.getByRole("checkbox", { name: "Also block Taylor" }),
    ).toBeChecked();
    await user.click(reportButton());

    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith({
      reportedUserId: "user-taylor",
      reason: "HARASSMENT",
      message: "Kept messaging.",
      requestId: undefined,
      alsoBlock: true,
    });
  });

  it("sends no message when none was written, and no block when unticked", async () => {
    const { user } = renderDialog("req-1");

    await user.selectOptions(
      screen.getByLabelText("Reason"),
      REPORT_REASON_LABELS.NO_SHOW,
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Also block Taylor" }),
    );
    await user.click(reportButton());

    expect(mockReport).toHaveBeenCalledWith({
      reportedUserId: "user-taylor",
      reason: "NO_SHOW",
      message: undefined,
      requestId: "req-1",
      alsoBlock: false,
    });
  });

  it("caps the message at the column width and counts toward it", async () => {
    const { user } = renderDialog();
    const box = screen.getByLabelText("What happened? (optional)");

    expect(box).toHaveAttribute("maxLength", String(REPORT_MESSAGE_MAX_LENGTH));
    expect(screen.getByText(`0/${REPORT_MESSAGE_MAX_LENGTH}`)).toBeVisible();

    await user.type(box, "abc");

    expect(screen.getByText(`3/${REPORT_MESSAGE_MAX_LENGTH}`)).toBeVisible();
  });

  it("says the conversation is included only when reporting from one", () => {
    const notice = `The last ${REPORT_SNAPSHOT_MESSAGE_LIMIT} messages in this conversation will be included for the admins to review.`;

    const { unmount } = render(
      <ReportDialog userId="u" userName="Taylor" onClose={jest.fn()} />,
    );
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
    unmount();

    renderDialog("req-1");
    expect(screen.getByText(notice)).toBeVisible();
  });

  it("on a report with a block, refreshes the block caches, then closes and calls onBlocked", async () => {
    const { onClose, onBlocked } = renderDialog();

    await act(async () => {
      await mockMutationOptions.onSuccess?.({
        reportId: "r1",
        blocked: true,
        blockRefusal: null,
      });
    });

    expect(mockInvalidate).toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith(
      "Thanks. We've received your report, and you blocked Taylor.",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it("on a report whose block was refused, shows the refusal as a note and does not call onBlocked", async () => {
    const { onClose, onBlocked } = renderDialog();

    await act(async () => {
      await mockMutationOptions.onSuccess?.({
        reportId: "r1",
        blocked: false,
        blockRefusal: BLOCK_GROUP_MEMBER_MESSAGE,
      });
    });

    expect(mockToast.success).toHaveBeenCalledWith(
      "Thanks. We've received your report.",
    );
    expect(mockToast.info).toHaveBeenCalledWith(BLOCK_GROUP_MEMBER_MESSAGE);
    expect(mockInvalidate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("on an error, shows the server's words and stays open", () => {
    const { onClose } = renderDialog();

    act(() => {
      mockMutationOptions.onError?.({ message: DUPLICATE_REPORT_MESSAGE });
    });

    expect(mockToast.error).toHaveBeenCalledWith(DUPLICATE_REPORT_MESSAGE);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Report Taylor" })).toBeVisible();
  });

  it("closes on Cancel without sending", async () => {
    const { onClose, user } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });
});
