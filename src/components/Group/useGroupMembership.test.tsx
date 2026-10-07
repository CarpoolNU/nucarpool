/**
 * The post-match feedback prompt on every membership change, and the set of
 * caches each one invalidates.
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
 *
 * **`useUtils` records rather than enumerates.** It used to be a literal
 * `{ user: { me, groups: { me } } }`, which is to say the fixture encoded the
 * set the hook happened to invalidate. Two consequences, both of which hid
 * SCRUM-629: a missing invalidation could not fail, because nothing asserted
 * the set; and adding one threw `Cannot read properties of undefined` from
 * inside `onSuccess` rather than failing an assertion that named it. See
 * `src/testing/invalidationRecorder.ts`.
 */

import { render, renderHook, screen } from "@testing-library/react";
import { isValidElement, ReactElement } from "react";
import { toast } from "react-toastify/unstyled";
import { trpc } from "../../utils/trpc";
import { FEEDBACK_FORM_URL } from "../../utils/feedbackForm";
import { recordInvalidations } from "../../testing/invalidationRecorder";
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

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

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

/**
 * Everything a membership change makes stale, which is the list in
 * `src/utils/groups/invalidateMembershipCaches.ts`.
 *
 * Written out here rather than imported from it: a test that reads its
 * expectation off the code under test asserts only that the code equals
 * itself.
 */
const MEMBERSHIP_CACHES = [
  "mapbox.geoJsonUserList.invalidate",
  "user.groups.me.invalidate",
  "user.me.invalidate",
  "user.recommendations.me.invalidate",
  "user.requests.me.invalidate",
];

let recorder = recordInvalidations();

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
  recorder = recordInvalidations();
  mockedTrpc.useUtils.mockReturnValue(recorder.utils);
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

/**
 * SCRUM-629.
 *
 * A grouped RIDER is a searcher no driver could accept, so
 * `buildCandidateWhere` answers `recommendations.me` and `geoJsonUserList`
 * with nothing at all - correctly, while they are grouped. Leaving makes that
 * answer false, and neither query heals on its own: `utils/trpc.ts` turns
 * `refetchOnMount` and `refetchOnWindowFocus` off globally, both queries are
 * owned by `pages/index.tsx`, and `GroupPage` renders *inside* it - so leaving
 * never unmounts the page that owns them, and the query key does not change.
 * The rider was left on an Explore sidebar with no cards and a map with no
 * pins, indistinguishable from "no drivers match you".
 *
 * The exact set is asserted, not a count: `groups.me` was the cache missing
 * from `requestHandlers.ts` and two discovery queries were missing here, and a
 * counter cannot say which. `requests.me` belongs on this path too, not only
 * on accept - every row it returns carries the caller's *own* `carpoolId` and
 * `seatAvail` through `convertCarpoolSearchToPublicWithExactHome`, and leaving
 * changes both.
 */
describe("the caches a membership change invalidates", () => {
  it("refreshes discovery when the driver dissolves the group", () => {
    renderMembership().remove.onSuccess(undefined, { riderId: "" });
    expect(recorder.paths()).toEqual(MEMBERSHIP_CACHES);
  });

  it("refreshes discovery when the caller leaves", () => {
    renderMembership().edit.onSuccess({ id: "group-1" }, { riderId: CALLER });
    expect(recorder.paths()).toEqual(MEMBERSHIP_CACHES);
  });

  /*
   * The driver's own side of a removal. They keep their group, so nothing
   * about them stopped matching - but a seat was credited back, which is
   * exactly what `searcherCanMatchNobody` reads for a DRIVER, so a driver who
   * had been at zero becomes matchable again on this path and no other.
   */
  it("refreshes discovery when a driver removes somebody else", () => {
    renderMembership().edit.onSuccess({ id: "group-1" }, { riderId: OTHER });
    expect(recorder.paths()).toEqual(MEMBERSHIP_CACHES);
  });

  it("refreshes discovery when a removal dissolves the group", () => {
    renderMembership().edit.onSuccess(null, { riderId: OTHER });
    expect(recorder.paths()).toEqual(MEMBERSHIP_CACHES);
  });

  /*
   * Each cache once, so the shared helper cannot be called twice over - two
   * refetches of the scoring pass and two against the Mapbox quota, which is
   * the cost `utils/trpc.ts` exists to contain.
   */
  it("invalidates each cache exactly once", () => {
    renderMembership().edit.onSuccess({ id: "group-1" }, { riderId: CALLER });
    expect([...recorder.calls].sort()).toEqual(MEMBERSHIP_CACHES);
  });

  it("invalidates nothing when the mutation failed", () => {
    renderMembership().edit.onError({ message: "nope" });
    expect(recorder.calls).toEqual([]);
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
