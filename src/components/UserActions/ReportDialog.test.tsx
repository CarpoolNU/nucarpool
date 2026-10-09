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
import { toastSpies } from "../../testing/toastStub";

/**
 * The report form.
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

/**
 * Every `invalidate` the dialog makes, by path.
 *
 * It records the path because two different refreshes now run on success and
 * they have to be told apart: the reporter's own list is refreshed on every
 * report, and the seven block caches only when "Also block" went through. A
 * single anonymous spy would make "the block caches were left alone" pass on
 * a call that was really the reports list.
 */
const mockInvalidate = jest.fn();
const invalidatedPaths = () =>
  mockInvalidate.mock.calls.map(([path]) => path as string);

jest.mock("../../utils/trpc", () => {
  const invalidator = (path: string) => ({
    invalidate: (...args: unknown[]) => mockInvalidate(path, ...args),
  });
  return {
    trpc: {
      useUtils: () => ({
        user: {
          reports: { me: invalidator("user.reports.me") },
          blocks: { me: invalidator("user.blocks.me") },
          recommendations: { me: invalidator("user.recommendations.me") },
          favorites: { me: invalidator("user.favorites.me") },
          requests: { me: invalidator("user.requests.me") },
          messages: {
            getUnreadMessageCount: invalidator(
              "user.messages.getUnreadMessageCount",
            ),
            conversation: invalidator("user.messages.conversation"),
          },
        },
        mapbox: { geoJsonUserList: invalidator("mapbox.geoJsonUserList") },
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

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);
const mockToast = toastSpies();

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

    // Eight: the reporter's own list, plus the seven in
    // `invalidateBlockCaches`.
    expect(invalidatedPaths()).toContain("user.blocks.me");
    expect(mockInvalidate).toHaveBeenCalledTimes(8);
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
    // The reporter's own list still refreshes - the report was saved. Nothing
    // the block was hiding changes, because no block was placed.
    expect(invalidatedPaths()).toEqual(["user.reports.me"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  /*
   * The report the user has just filed has to appear in the profile list the
   * duplicate-report refusal sends them to. `defaultQueryOptions` sets
   * `refetchOnMount: false`, so a profile visited earlier in the session
   * would otherwise show the list as it was before this report existed.
   */
  it("refreshes the reporter's own list of reports, block or no block", async () => {
    renderDialog();

    await act(async () => {
      await mockMutationOptions.onSuccess?.({
        reportId: "r1",
        blocked: false,
        blockRefusal: null,
      });
    });

    expect(invalidatedPaths()).toEqual(["user.reports.me"]);
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

  /**
   * SCRUM-624. Both facts are true of the server today - `reports.create`
   * mails the admins and its docblock is explicit that the reported user is
   * told nothing - and neither reached the person deciding whether to file.
   */
  it("says the report reaches the admins only, and that the person is not told", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", { name: "Report Taylor" });
    expect(dialog).toHaveTextContent("This goes to the NUCarpool admins only.");
    expect(dialog).toHaveTextContent(
      "Taylor is not told that you reported them.",
    );
  });

  it("links to the safety guidance", () => {
    renderDialog();

    expect(
      screen.getByRole("link", {
        name: "Reporting, blocking and staying safe",
      }),
    ).toHaveAttribute("href", "/safety");
  });

  it("closes on Cancel without sending", async () => {
    const { onClose, user } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });
});
