/**
 * `setup.tsx`'s `onSubmit` had no `try`/`catch` around `updateUser`.
 *
 * It sets `isLoading(true)` and relied entirely on `useEditUserMutation`'s
 * settle callback to clear it. `isLoading` swaps the whole wizard for a
 * full-screen spinner, so a throw that never reached the mutation - and so
 * never reached that callback - left onboarding as a spinner with no way out,
 * plus an unhandled rejection. The user's answers are still in the form state
 * behind it, and a reload loses them.
 *
 * Two cases, because the right amount of reporting differs:
 *
 *  - A throw that **never reached the mutation** has not been reported by
 *    anything, so `onSubmit` owns the toast.
 *  - A rejection **from the mutation** has already been toasted by
 *    `useEditUserMutation`'s `onError`, which React Query also routes a throw
 *    inside `onSuccess` to. A second toast there would double up.
 *
 * Both must release the spinner. That is the part that was broken.
 *
 * The Viewer path is the shortest route to `onSubmit` - one confirmation from
 * step 1 - and is why this file mirrors `setupViewerConfirmation.test.tsx`
 * rather than driving the full four-step wizard. Deliberately not co-located
 * under `src/pages/`, for the reason `setupNavigationPlacement.test.tsx`
 * gives: a test file there is also a route.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);

jest.mock("../../utils/trpc", () => ({
  trpc: {
    mapbox: {
      search: { useQuery: () => ({ data: undefined, error: null }) },
    },
    user: {
      me: {
        useQuery: () => ({
          data: {
            role: "RIDER",
            hasCarpoolSearch: false,
            seatAvail: 0,
            status: "ACTIVE",
            companyName: "",
            companyAddress: "",
            startAddress: "",
            preferredName: "",
            pronouns: "",
            daysWorking: "0,1,1,1,1,1,0",
            startTime: null,
            endTime: null,
            coopStartDate: null,
            coopEndDate: null,
            bio: "",
            startCoordLng: 0,
            startCoordLat: 0,
            companyCoordLng: 0,
            companyCoordLat: 0,
          },
        }),
      },
    },
  },
}));

const mockToastError = jest.fn();
jest.mock("react-toastify/unstyled", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    warning: jest.fn(),
    success: jest.fn(),
  },
}));

jest.mock("../../utils/mixpanel", () => ({
  trackFTUEStep: jest.fn(),
  trackFTUECompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
// Stubbed beside the upload hook for the same reason: the page calls it
// unconditionally at render, and the real one reaches for a tRPC mutation
// this suite's `trpc` mock does not declare.
jest.mock("../../utils/profile/useRemoveProfilePicture", () => ({
  useRemoveProfilePicture: () => ({ removeProfilePicture: jest.fn() }),
}));

const mockUpdateUser = jest.fn();
jest.mock("../../utils/profile/updateUser", () => ({
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  useEditUserMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
}));

jest.mock("../../components/Setup/StepTwo", () => ({
  __esModule: true,
  default: () => <div>step two</div>,
}));
jest.mock("../../components/Setup/StepThree", () => ({
  __esModule: true,
  default: () => <div>step three</div>,
}));
jest.mock("../../components/Setup/StepFour", () => ({
  __esModule: true,
  default: () => <div>step four</div>,
}));
jest.mock("../../components/Setup/ProgressBar", () => ({
  __esModule: true,
  default: () => <div>progress</div>,
}));

import Setup from "../../pages/profile/setup";

/**
 * Step 1 as a Viewer, then both taps of "View Map" - the second is the
 * confirmation modal's, and is what runs `onSubmit`.
 */
const submitAsViewer = async () => {
  const view = render(<Setup />);
  await act(async () => {
    screen.getByRole("button", { name: "Get Started" }).click();
  });
  // See `setupViewerRoleDefault.test.tsx`: `role` is spread onto the input as
  // a reserved HTML/ARIA attribute, so the radio is found by `id`.
  const viewerRadio =
    view.container.querySelector<HTMLInputElement>("#viewer")!;
  await act(async () => {
    fireEvent.click(viewerRadio);
  });
  await act(async () => {
    screen.getByRole("button", { name: "View Map" }).click();
  });
  // The modal's confirm, which shares the label.
  await act(async () => {
    screen.getAllByRole("button", { name: "View Map" }).at(-1)!.click();
  });
  return view;
};

/** The spinner `isLoading` swaps the wizard for. */
const spinner = () => screen.queryByText("Loading...");

beforeEach(() => {
  mockUpdateUser.mockReset();
  mockToastError.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a failed onboarding submit", () => {
  it("releases the spinner and reports a throw that never reached the mutation", async () => {
    mockUpdateUser.mockRejectedValue(new Error("could not build the payload"));

    await submitAsViewer();

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    // Otherwise this stays on screen for good, with the wizard gone.
    expect(spinner()).not.toBeInTheDocument();
    // Nothing else had a chance to say anything, so `onSubmit` must.
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("releases the spinner without a second toast when the mutation itself rejected", async () => {
    mockUpdateUser.mockRejectedValue(
      new TRPCClientError("Something went wrong: seats must be positive"),
    );

    await submitAsViewer();

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(spinner()).not.toBeInTheDocument();
    // `useEditUserMutation`'s `onError` has already toasted this one. The
    // control that keeps the fix from double-reporting every mutation error.
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("leaves the wizard usable on success and does not toast", async () => {
    mockUpdateUser.mockResolvedValue(undefined);

    await submitAsViewer();

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
