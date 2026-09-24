/**
 * The post-match feedback prompt on every membership change. SCRUM-545.
 *
 * Every success path in `useGroupMembership` ends a pairing the caller was in,
 * so each one must carry the link to the feedback form - and no error path
 * may, since nothing ended. The paths are driven by calling the `onSuccess` /
 * `onError` the hook hands to `useMutation`, which is the only place the
 * outcome is decided; `trpc` is mocked as a shape, as in
 * `GroupPage.driverless.test.tsx`.
 *
 * The toast is then rendered on its own to read the link off it. That proves
 * what the toast *contains*, not that `ToastContainer` draws it - the
 * container is mocked out with the rest of `react-toastify`.
 */

import { render, renderHook, screen } from "@testing-library/react";
import { isValidElement, ReactElement } from "react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import { FEEDBACK_FORM_URL } from "../../utils/feedbackForm";
import { useGroupMembership } from "./useGroupMembership";

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: jest.fn(),
    user: {
      groups: {
        edit: { useMutation: jest.fn() },
        delete: { useMutation: jest.fn() },
      },
    },
  },
}));

jest.mock("react-toastify/unstyled", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

type MutationOptions = {
  onSuccess: (data: unknown, variables: { riderId: string }) => void;
  onError: (error: { message: string }) => void;
};

const mockedTrpc = trpc as unknown as {
  useUtils: jest.Mock;
  user: {
    groups: {
      edit: { useMutation: jest.Mock };
      delete: { useMutation: jest.Mock };
    };
  };
};

const mockedToast = toast as unknown as {
  success: jest.Mock;
  error: jest.Mock;
};

const CALLER = "caller";
const OTHER = "other";

/** The options the hook passed to each mutation, from its latest render. */
const optionsFor = (mutation: jest.Mock): MutationOptions =>
  mutation.mock.calls[mutation.mock.calls.length - 1][0];

const renderMembership = () => {
  renderHook(() =>
    useGroupMembership({
      groupId: "group-1",
      driverId: "driver-1",
      currentUserId: CALLER,
    }),
  );
  return {
    edit: optionsFor(mockedTrpc.user.groups.edit.useMutation),
    remove: optionsFor(mockedTrpc.user.groups.delete.useMutation),
  };
};

/** Renders the single success toast raised so far and returns its options. */
const renderRaisedToast = () => {
  expect(mockedToast.success).toHaveBeenCalledTimes(1);
  const [content, options] = mockedToast.success.mock.calls[0];
  expect(isValidElement(content)).toBe(true);
  render(content as ReactElement);
  return options;
};

const expectFeedbackPrompt = (message: string) => {
  const options = renderRaisedToast();

  expect(screen.getByText(message)).toBeInTheDocument();
  const link = screen.getByRole("link", {
    name: "Tell us how the carpool went",
  });
  expect(link).toHaveAttribute("href", FEEDBACK_FORM_URL);
  // A new tab, so following the prompt does not unload the app mid-refetch.
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  // A timed toast would take the link away before a slow reader reached it.
  expect(options).toEqual(expect.objectContaining({ autoClose: false }));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedTrpc.useUtils.mockReturnValue({
    user: {
      me: { invalidate: jest.fn() },
      groups: { me: { invalidate: jest.fn() } },
    },
  });
  mockedTrpc.user.groups.edit.useMutation.mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
  });
  mockedTrpc.user.groups.delete.useMutation.mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
  });
});

describe("the feedback prompt after a pairing ends", () => {
  it("follows the driver deleting the group", () => {
    renderMembership().remove.onSuccess(undefined, { riderId: "" });
    expectFeedbackPrompt("Group has been successfully deleted");
  });

  it("follows the caller leaving", () => {
    renderMembership().edit.onSuccess({ id: "group-1" }, { riderId: CALLER });
    expectFeedbackPrompt("You have left the group");
  });

  it("follows the driver removing a rider from a group that carries on", () => {
    renderMembership().edit.onSuccess({ id: "group-1" }, { riderId: OTHER });
    expectFeedbackPrompt("Removed from group");
  });

  it("follows a removal that dissolves the group", () => {
    renderMembership().edit.onSuccess(null, { riderId: OTHER });
    expectFeedbackPrompt(
      "Removed from group — with nobody left, the group was disbanded",
    );
  });
});

describe("no prompt when nothing ended", () => {
  it("is absent from a failed leave", () => {
    renderMembership().edit.onError({ message: "nope" });
    expect(mockedToast.success).not.toHaveBeenCalled();
    expect(mockedToast.error).toHaveBeenCalledWith(
      "Something went wrong: nope",
    );
  });

  it("is absent from a failed delete", () => {
    renderMembership().remove.onError({ message: "nope" });
    expect(mockedToast.success).not.toHaveBeenCalled();
    expect(mockedToast.error).toHaveBeenCalledWith(
      "Something went wrong: nope",
    );
  });
});
