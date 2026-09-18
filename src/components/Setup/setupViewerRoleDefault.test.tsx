/**
 * SCRUM-508: a brand-new user has no `CarpoolSearch` row, so `user.me` can
 * only report `role: VIEWER` as the `?? Role.VIEWER` fallback in
 * `src/server/router/user.ts`, not as a stored choice. The wizard's
 * `initialLoad` effect used to `reset({ role: user.role, ... })`
 * unconditionally, which overwrote its own `RIDER` default with that
 * fallback and left a new user on step 1 with Viewer selected and the
 * one-tap "View Map" submit button - the defect this pins.
 *
 * `hasCarpoolSearch` is what lets the effect tell the two situations apart:
 * skip restoring `role` when it is `false`, restore it when a returning user
 * genuinely stored VIEWER. Both cases are asserted here so a regression in
 * either direction fails a test.
 *
 * `InitialStep` is rendered for real, unlike `setupNavigationPlacement.test`'s
 * stub, because the radio selection and button label are exactly what is
 * under test.
 *
 * Deliberately not co-located under `src/pages/`, for the reason
 * `setupNavigationPlacement.test.tsx` gives: a test file there is also a
 * route.
 */

import { render, screen, act } from "@testing-library/react";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
}));

const mockUseMeQuery = jest.fn();

jest.mock("../../utils/trpc", () => ({
  trpc: {
    mapbox: {
      search: { useQuery: () => ({ data: undefined, error: null }) },
    },
    user: {
      me: {
        useQuery: (...args: unknown[]) => mockUseMeQuery(...args),
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
jest.mock("../../utils/profile/updateUser", () => ({
  updateUser: jest.fn(),
  useEditUserMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
}));

// Steps 2-4 are unreached from step 1 in every test here; stubbed for the same
// reason `setupNavigationPlacement.test.tsx` stubs them.
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

/** The fields the wizard's `initialLoad` effect and step 1 actually read. */
const baseUser = {
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
};

/** Renders the wizard and advances from step 0 to step 1. */
const renderAtStepOne = async () => {
  const view = render(<Setup />);
  await act(async () => {
    screen.getByRole("button", { name: "Get Started" }).click();
  });
  return view;
};

/**
 * `FormRadioButton` spreads a `role={Role.X}` prop onto the native
 * `<input type="radio">`, which - because `role` is a reserved HTML/ARIA
 * attribute - overwrites its implicit accessible role with the literal
 * string "VIEWER"/"RIDER"/"DRIVER" instead of "radio". That is a real,
 * pre-existing accessibility defect, tracked separately rather than fixed
 * here; querying by `id` sidesteps it instead of asserting the broken role
 * as though it were correct.
 */
const radioFor = (container: HTMLElement, id: "viewer" | "rider" | "driver") =>
  container.querySelector<HTMLInputElement>(`#${id}`)!;

describe("onboarding wizard step 1 — role default (SCRUM-508)", () => {
  it("selects Rider, not Viewer, for a brand-new user with no CarpoolSearch row", async () => {
    mockUseMeQuery.mockReturnValue({
      data: { ...baseUser, role: "VIEWER", hasCarpoolSearch: false },
    });

    const { container } = await renderAtStepOne();

    expect(radioFor(container, "rider").checked).toBe(true);
    expect(radioFor(container, "viewer").checked).toBe(false);
    expect(
      screen.getByRole("button", { name: /Continue/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "View Map" }),
    ).not.toBeInTheDocument();
  });

  it("restores Viewer for a returning user whose CarpoolSearch genuinely stores it", async () => {
    mockUseMeQuery.mockReturnValue({
      data: { ...baseUser, role: "VIEWER", hasCarpoolSearch: true },
    });

    const { container } = await renderAtStepOne();

    expect(radioFor(container, "viewer").checked).toBe(true);
    expect(
      screen.getByRole("button", { name: "View Map" }),
    ).toBeInTheDocument();
  });
});
