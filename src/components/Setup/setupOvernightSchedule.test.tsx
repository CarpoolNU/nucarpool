/**
 * Onboarding asks before leaving the schedule step with an end at or before
 * the start (SCRUM-732), the same question `/profile` asks at save time.
 *
 * Asked on the schedule step's Continue rather than at Complete, because that
 * is where the pickers are: answering "Change times" leaves the user looking at
 * the two fields to fix, not two steps further on.
 *
 * `StepThree` is a stub around the real `SelectTimeRange`, whose antd panels
 * are clicked cell by cell. The rest of the wizard is real. Not co-located
 * under `src/pages/`, because a test file there is also a route.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Control } from "react-hook-form";
import type { OnboardingFormInputs } from "../../utils/types";
import {
  installResizeObserverStub,
  pickTime,
} from "../../testing/timePickerDriver";
import { scheduleReconfirmationKey } from "../../utils/profile/useScheduleReconfirmationRecord";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);

/**
 * A returning RIDER with addresses and co-op dates already stored, so every
 * step before the schedule passes its gate, and no schedule yet.
 */
const USER = {
  id: "user-onboarding",
  role: "RIDER",
  hasCarpoolSearch: true,
  seatAvail: 0,
  status: "ACTIVE",
  companyName: "Acme",
  companyAddress: "1 Main St, Boston, MA",
  startAddress: "360 Huntington Ave, Boston, MA",
  preferredName: "",
  pronouns: "",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: null,
  endTime: null,
  coopStartDate: new Date(2026, 8, 1),
  coopEndDate: new Date(2026, 11, 18),
  bio: "",
  startCoordLng: -71.0892,
  startCoordLat: 42.3398,
  companyCoordLng: -71.0589,
  companyCoordLat: 42.3601,
};

jest.mock("../../utils/trpc", () => ({
  trpc: { user: { me: { useQuery: () => ({ data: USER }) } } },
}));
jest.mock("../../utils/useAddressSelection", () => ({
  useAddressSelection: () => ({
    selectedAddress: {
      center: [-71.0892, 42.3398],
      street: "",
      city: "",
      state: "",
    },
    setSelectedAddress: jest.fn(),
    address: "",
    setAddress: jest.fn(),
    suggestions: [],
    setSuggestions: jest.fn(),
  }),
}));
jest.mock("../../utils/mixpanel", () => ({
  trackFTUEStep: jest.fn(),
  trackFTUECompletion: jest.fn(),
}));
jest.mock("../../utils/profile/useUploadFile", () => ({
  useUploadFile: () => ({ uploadFile: jest.fn() }),
}));
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
jest.mock("../../components/Setup/StepThree", () => {
  const SelectTimeRange = jest.requireActual(
    "../Schedule/SelectTimeRange",
  ).default;

  return {
    __esModule: true,
    default: (props: { control: Control<OnboardingFormInputs> }) => (
      <>
        <div>step three</div>
        <SelectTimeRange control={props.control} />
      </>
    ),
  };
});
jest.mock("../../components/Setup/StepFour", () => ({
  __esModule: true,
  default: () => <div>step four</div>,
}));
jest.mock("../../components/Setup/ProgressBar", () => ({
  __esModule: true,
  default: () => <div>progress</div>,
}));

import Setup from "../../pages/profile/setup";

installResizeObserverStub();

const pressContinue = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  });
};

/** Get Started, then Continue past the role and address steps. */
const renderAtScheduleStep = async () => {
  render(<Setup />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Get Started" }));
  });
  await pressContinue();
  await screen.findByText("step two");
  await pressContinue();
  await screen.findByText("step three");
};

const startInput = () => screen.getByLabelText(/Start Time/);
const endInput = () => screen.getByLabelText(/End Time/);

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

/** What SCRUM-733's profile notice will read for this account on this device. */
const reconfirmationRecord = () => {
  const raw = window.localStorage.getItem(scheduleReconfirmationKey(USER.id));
  return raw === null ? null : JSON.parse(raw);
};

/** Step 3's Continue on a 9:00 AM to 5:00 AM, kept at the question. */
const keepNineToFive = async () => {
  await renderAtScheduleStep();
  await pickTime(startInput(), { hour: "09" });
  await pickTime(endInput(), { hour: "05", meridiem: "AM" });
  await pressContinue();
  fireEvent.click(
    await screen.findByRole("button", { name: "Keep overnight" }),
  );
  await screen.findByText("step four");
};

const pressComplete = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
  });
};

describe("onboarding's schedule step", () => {
  it("moves on with no question for a same-day schedule", async () => {
    await renderAtScheduleStep();
    await pickTime(startInput(), { hour: "09" });
    await pickTime(endInput(), { hour: "05" });

    await pressContinue();

    expect(await screen.findByText("step four")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks before moving on with an end before the start", async () => {
    await renderAtScheduleStep();
    await pickTime(startInput(), { hour: "09" });
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });

    await pressContinue();

    expect(
      await screen.findByRole("dialog", {
        name: "Does your shift run overnight?",
      }),
    ).toHaveTextContent("9:00 AM to 5:00 AM");
    expect(screen.queryByText("step four")).not.toBeInTheDocument();
  });

  it("stays on the schedule step on Change times", async () => {
    await renderAtScheduleStep();
    await pickTime(startInput(), { hour: "09" });
    await pickTime(endInput(), { hour: "05", meridiem: "AM" });
    await pressContinue();

    fireEvent.click(
      await screen.findByRole("button", { name: "Change times" }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("step three")).toBeInTheDocument();
    expect(screen.queryByText("step four")).not.toBeInTheDocument();
    expect(reconfirmationRecord()).toBeNull();
  });

  it("records nothing when Keep overnight is pressed, before anything is saved", async () => {
    await keepNineToFive();

    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(reconfirmationRecord()).toBeNull();
  });

  it("remembers a kept 9:00 AM to 5:00 AM as confirmed once onboarding saves it, so the profile does not ask about it again", async () => {
    mockUpdateUser.mockResolvedValueOnce(undefined);
    await keepNineToFive();

    await pressComplete();

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(reconfirmationRecord()).toEqual({
      confirmed: {
        startMinute: 540,
        endMinute: 300,
        confirmedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
      snoozed: null,
    });
    // This account's key, and no other.
    expect(Object.keys(window.localStorage)).toEqual([
      scheduleReconfirmationKey(USER.id),
    ]);
  });

  it("remembers nothing when the save of a kept schedule is refused", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      mockUpdateUser.mockRejectedValueOnce(new Error("Refused"));
      await keepNineToFive();

      await pressComplete();

      await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
      expect(reconfirmationRecord()).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("moves on once a real night shift is kept, and does not ask again", async () => {
    await renderAtScheduleStep();
    await pickTime(startInput(), { hour: "10", meridiem: "PM" });
    await pickTime(endInput(), { hour: "06" });
    await pressContinue();

    fireEvent.click(
      await screen.findByRole("button", { name: "Keep overnight" }),
    );

    expect(await screen.findByText("step four")).toBeInTheDocument();

    // Back to the schedule and forward again, unchanged: no second question.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    });
    await screen.findByText("step three");
    await pressContinue();
    expect(await screen.findByText("step four")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
