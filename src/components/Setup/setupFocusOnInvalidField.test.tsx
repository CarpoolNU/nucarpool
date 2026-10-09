/**
 * A failed step moves focus to the field that failed. Returning early without
 * moving focus shows sighted users red text appearing, but gives a
 * screen-reader user - or a sighted keyboard user on a long step - a button
 * press with no observable result at all, indistinguishable from a broken
 * button.
 *
 * This pins step 1's driver branch: pressing Continue with no seat count set
 * focuses the Seat Availability input rather than silently staying put. That branch is `setError` + an early return, not `trigger()`,
 * so it exercises the deterministic half of `focusFirstInvalidField` in
 * `setup.tsx` rather than the `getFieldState`-after-`trigger` half.
 *
 * Deliberately not co-located under `src/pages/`, for the reason
 * `setupNavigationPlacement.test.tsx` gives: a test file there is also a
 * route.
 */

import { render, screen, act, fireEvent } from "@testing-library/react";

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

const renderAtStepOneAsDriver = async () => {
  const view = render(<Setup />);
  await act(async () => {
    screen.getByRole("button", { name: "Get Started" }).click();
  });
  // Same reason `setupViewerConfirmation.test.tsx` finds Viewer by id: `role`
  // is spread onto the input as a reserved HTML/ARIA attribute, so none of
  // the three radios are reachable by accessible role or name.
  const driverRadio =
    view.container.querySelector<HTMLInputElement>("#driver")!;
  await act(async () => {
    fireEvent.click(driverRadio);
  });
  return view;
};

describe("onboarding wizard — focus on a failed Continue", () => {
  it("moves focus to Seat Availability when a driver has no seats set", async () => {
    await renderAtStepOneAsDriver();

    const seatInput = screen.getByRole("spinbutton", {
      name: /seat availability/i,
    });
    await act(async () => {
      fireEvent.change(seatInput, { target: { value: "0" } });
    });

    // Positive control: the field is not already focused before the failed
    // Continue press, so a pass here cannot be explained by focus that was
    // simply never moved from the input the user just typed into.
    await act(async () => {
      seatInput.blur();
    });
    expect(seatInput).not.toHaveFocus();

    await act(async () => {
      screen.getByRole("button", { name: "Continue" }).click();
    });

    expect(seatInput).toHaveFocus();

    // The announcement half of the same acceptance criterion: not just that
    // the message is somewhere on the page, but that it is a live region a
    // screen reader would actually speak, and that its content is what the
    // user just triggered.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Seat availability must be > 0",
    );
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
