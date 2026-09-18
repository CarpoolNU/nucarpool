/**
 * SCRUM-508: `handleNextStep`'s step-1 VIEWER branch used to call
 * `handleSubmit(onSubmit)` directly on the first tap of the primary button -
 * which is what `updateUser` writes `isOnboarded: true` from - with no
 * confirmation and no way back into the wizard. This pins the fix: selecting
 * Viewer and tapping the primary button opens `ViewerConfirmModal` instead of
 * submitting, and the submit only happens once that modal is explicitly
 * confirmed. Going back from the modal must leave onboarding un-submitted.
 *
 * Deliberately not co-located under `src/pages/`, for the reason
 * `setupNavigationPlacement.test.tsx` gives: a test file there is also a
 * route.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
}));

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

jest.mock("../../utils/mixpanel", () => ({
  trackFTUEStep: jest.fn(),
  trackFTUECompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
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

const renderAtStepOneAsViewer = async () => {
  const view = render(<Setup />);
  await act(async () => {
    screen.getByRole("button", { name: "Get Started" }).click();
  });
  // See `setupViewerRoleDefault.test.tsx`: `role` is spread onto the input as
  // a reserved HTML/ARIA attribute, so the radio is found by `id` rather than
  // an accessible role or name.
  const viewerRadio =
    view.container.querySelector<HTMLInputElement>("#viewer")!;
  await act(async () => {
    fireEvent.click(viewerRadio);
  });
  return view;
};

describe("onboarding wizard step 1 — Viewer requires confirmation (SCRUM-508)", () => {
  it("does not submit on the first tap; it opens a confirmation instead", async () => {
    await renderAtStepOneAsViewer();

    await act(async () => {
      screen.getByRole("button", { name: "View Map" }).click();
    });

    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(
      screen.getByText("View the map without setting up carpooling?"),
    ).toBeInTheDocument();
  });

  it("does not submit when the confirmation is dismissed with Go back", async () => {
    await renderAtStepOneAsViewer();
    await act(async () => {
      screen.getByRole("button", { name: "View Map" }).click();
    });

    await act(async () => {
      screen.getByRole("button", { name: "Go back" }).click();
    });

    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(
      screen.queryByText("View the map without setting up carpooling?"),
    ).not.toBeInTheDocument();
  });

  it("submits only once the confirmation is accepted", async () => {
    await renderAtStepOneAsViewer();
    await act(async () => {
      screen.getByRole("button", { name: "View Map" }).click();
    });

    // Two "View Map" buttons exist once the modal is open: the wizard's own
    // primary button, unmounted from view but still in the tree behind the
    // overlay, and the modal's confirm button rendered after it.
    const viewMapButtons = screen.getAllByRole("button", {
      name: "View Map",
    });
    expect(viewMapButtons).toHaveLength(2);

    await act(async () => {
      viewMapButtons[1].click();
    });

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });
});
