/**
 * SCRUM-561 item 1: the unsaved-changes modal's Save and Continue must not
 * leave the page when the save is refused.
 *
 * `onSubmit` caught the mutation's rejection, showed a toast, and then fell
 * through to `return true` - and `onSubmitWithContinue` reads `true` as "go
 * ahead", so it navigated (or signed out) anyway. The user saw two error
 * toasts, one from `useEditUserMutation`'s `onError` and one from the catch,
 * and the edits the modal had just offered to keep were gone.
 *
 * **The real page, the real modal and the real save path.** `updateUser` and
 * `useEditUserMutation` are not mocked: `trpc.user.edit.useMutation` is backed
 * by real React Query with a stubbed `mutationFn`, so the hook's own `onError`
 * toast runs and "one toast" is counted rather than assumed. `Header` is a stub
 * exposing the one thing it does here - calling `checkChanges` with the
 * navigation it wants - and `UserSection` is a stub registering one real field,
 * so the edit is a genuine form change that the real `hasProfileChanges` sees
 * and that can be read back after the failure. Not co-located, because a test
 * file under `src/pages/` is also a route.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UseFormRegister } from "react-hook-form";
import { OnboardingFormInputs } from "../../utils/types";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () => ({
  useRouter: () => ({
    push: jest.fn(),
    events: { on: jest.fn(), off: jest.fn() },
  }),
}));
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { name: "Test User" } } }),
}));

jest.mock("react-toastify/unstyled", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));

/** Set per test: what the server does with the save. */
let editBehaviour: () => Promise<unknown> = async () => ({});
const editFn = jest.fn(() => editBehaviour());

jest.mock("../../utils/trpc", () => {
  const reactQuery = jest.requireActual("@tanstack/react-query");
  return {
    trpc: {
      useUtils: () => ({
        user: {
          me: { refetch: jest.fn(async () => undefined) },
          recommendations: { me: { invalidate: jest.fn(async () => {}) } },
        },
        mapbox: { geoJsonUserList: { invalidate: jest.fn(async () => {}) } },
      }),
      user: {
        me: {
          useQuery: (input: unknown, options: object) =>
            reactQuery.useQuery({
              queryKey: ["user.me", input],
              queryFn: async () => VIEWER_USER,
              ...options,
            }),
        },
        edit: {
          useMutation: (options: object) =>
            reactQuery.useMutation({
              mutationFn: () => editFn(),
              ...options,
            }),
        },
      },
    },
  };
});

jest.mock("../../utils/mixpanel", () => ({
  trackProfileCompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
jest.mock("../../utils/useAddressSelection", () => ({
  useAddressSelection: () => ({
    selectedAddress: { center: [0, 0], street: "", city: "", state: "" },
    setSelectedAddress: jest.fn(),
    address: "",
    setAddress: jest.fn(),
    suggestions: [],
    setSuggestions: jest.fn(),
  }),
}));

/** The header's navigation, as the page receives it. */
const proceed = jest.fn();

jest.mock("../../components/Header", () => ({
  __esModule: true,
  default: (props: {
    checkChanges: (proceed: () => void) => Promise<void>;
  }) => <button onClick={() => void props.checkChanges(proceed)}>Leave</button>,
}));
jest.mock("../../components/Profile/UserSection", () => ({
  __esModule: true,
  default: (props: { register: UseFormRegister<OnboardingFormInputs> }) => (
    <input aria-label="Preferred name" {...props.register("preferredName")} />
  ),
}));
jest.mock("../../components/Profile/CarpoolSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/AccountSection", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../../components/Profile/BlockedUsersSection", () => ({
  __esModule: true,
  default: () => null,
}));

import { toast } from "react-toastify/unstyled";
import Profile from "../../pages/profile/index";

/**
 * A VIEWER, because neither the schema's co-op date rules nor the address
 * guard apply to one - so Save reaches the server without this file having to
 * satisfy either, and the only thing that can fail it is the server.
 */
const VIEWER_USER = {
  role: "VIEWER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "ACTIVE",
  companyName: "",
  companyAddress: "",
  startAddress: "",
  preferredName: "Sam",
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

const renderProfile = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: {} },
        })
      }
    >
      <Profile />
    </QueryClientProvider>,
  );

/** Edits the field, tries to leave, and picks Save and Continue. */
const editThenSaveAndContinue = async () => {
  const field = await screen.findByLabelText("Preferred name");
  await waitFor(() => expect(field).toHaveValue("Sam"));
  fireEvent.change(field, { target: { value: "Samantha" } });

  fireEvent.click(screen.getByRole("button", { name: "Leave" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Save and Continue" }),
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  editBehaviour = async () => ({});
});

describe("/profile Save and Continue", () => {
  it("stays on the page when the save is refused", async () => {
    editBehaviour = async () => {
      throw new Error("Refused");
    };

    renderProfile();
    await editThenSaveAndContinue();

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    // Back from the save spinner with the form, not away.
    const field = await screen.findByLabelText("Preferred name");

    expect(proceed).not.toHaveBeenCalled();
    // The edit the modal offered to keep is still there to retry.
    expect(field).toHaveValue("Samantha");
  });

  it("shows exactly one error toast for a refused save", async () => {
    editBehaviour = async () => {
      throw new Error("Refused");
    };

    renderProfile();
    await editThenSaveAndContinue();

    await screen.findByLabelText("Preferred name");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    // `useEditUserMutation`'s, which carries the server's reason. The catch in
    // `onSubmit` used to add a second, vaguer one.
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("Something went wrong: Refused");
  });

  /**
   * The regression the fix had to preserve, and the control for the two cases
   * above: a page that never navigated at all would pass both and fail this.
   */
  it("control: a successful save still navigates", async () => {
    renderProfile();
    await editThenSaveAndContinue();

    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(editFn).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
