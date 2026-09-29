/**
 * SCRUM-594: the wizard was a pile of inputs and a `type="button"` Continue, so
 * Enter in a field did nothing at all.
 *
 * It is one `<form>` now, and Enter in a field is the same event as a press of
 * Continue: both reach `handleNextStep`, so the per-step gate applies to both.
 * What is worth pinning is how easily that goes wrong in the other direction -
 * inside a form, an untyped `<button>` submits, so each of these is a way to
 * advance a step (or write a profile) the user did not ask for:
 *
 * - "Get Started" and Continue both running `handleNextStep`, so one press
 *   skips a step;
 * - Previous submitting the step it is meant to leave;
 * - Enter in the bio textarea, which must stay a newline;
 * - Enter on a read-only picker input, which belongs to the picker;
 * - the browser's own `min` check swallowing the submit before the gate runs.
 *
 * **Every key press here is `user.keyboard("{Enter}")` on a focused field**, not
 * `fireEvent.submit(form)`. user-event only submits on Enter when the form has
 * a submit button, so a wizard without a real form, or with Continue reverted
 * to `type="button"`, fails these instead of passing through a hand-fired event.
 *
 * Deliberately not co-located under `src/pages/`, for the reason
 * `setupNavigationPlacement.test.tsx` gives: a test file there is also a route.
 */

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);
jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

/**
 * A DRIVER with every later step's data already valid, so each gate passes
 * when a test wants it to and the only thing under test is what triggers it.
 * Held in a constant because `user` is an effect dependency on the page: a
 * fresh object per render would re-seed the address hooks on every render.
 *
 * `hasCarpoolSearch: true` because otherwise the page ignores `role` and
 * starts a new user on the default.
 */
const mockUser = {
  role: "DRIVER",
  hasCarpoolSearch: true,
  seatAvail: 2,
  status: "ACTIVE",
  companyName: "Acme",
  companyAddress: "1 Main St, Boston",
  startAddress: "2 Oak St, Boston",
  preferredName: "",
  pronouns: "",
  daysWorking: "0,1,1,1,1,1,0",
  startTime: new Date("1970-01-01T13:00:00Z"),
  endTime: new Date("1970-01-01T21:00:00Z"),
  coopStartDate: new Date("2027-01-15T00:00:00Z"),
  coopEndDate: new Date("2027-06-15T00:00:00Z"),
  bio: "",
  startCoordLng: -71.06,
  startCoordLat: 42.36,
  companyCoordLng: -71.09,
  companyCoordLat: 42.34,
};

jest.mock("../../utils/trpc", () => ({
  trpc: {
    mapbox: {
      search: { useQuery: () => ({ data: undefined, error: null }) },
    },
    user: {
      me: { useQuery: () => ({ data: mockUser }) },
    },
  },
}));

const mockTrackFTUEStep = jest.fn();
jest.mock("../../utils/mixpanel", () => ({
  trackFTUEStep: (...args: unknown[]) => mockTrackFTUEStep(...args),
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

/*
 * Steps 2 and 3 are stubbed to a bare input each. The address comboboxes and
 * the date and time pickers are covered where they live; what matters here is
 * that there is a field to press Enter in, and - on step 3 - a read-only one
 * standing in for a picker's input.
 */
jest.mock("../../components/Setup/StepTwo", () => ({
  __esModule: true,
  default: () => <input aria-label="Step two field" />,
}));
jest.mock("../../components/Setup/StepThree", () => ({
  __esModule: true,
  default: () => (
    <>
      <input aria-label="Step three field" />
      <input aria-label="Step three picker" readOnly />
    </>
  ),
}));
jest.mock("../../components/Setup/ProgressBar", () => ({
  __esModule: true,
  default: () => <div>progress</div>,
}));

import Setup from "../../pages/profile/setup";

/**
 * Not a `beforeEach` alone: `mockUpdateUser` and the tracker are module-level,
 * so a count left over from the previous test would read as this test's calls.
 */
beforeEach(() => {
  mockTrackFTUEStep.mockClear();
  mockUpdateUser.mockClear();
});

const STEP_ONE_HEADING = "Please select a role to start:";

const seatInput = () =>
  screen.getByRole("spinbutton", { name: /seat availability/i });
const continueButton = () => screen.getByRole("button", { name: "Continue" });

/** Renders the wizard and presses Get Started, which lands on step 1. */
const startWizard = async () => {
  const user = userEvent.setup();
  render(<Setup />);
  await user.click(screen.getByRole("button", { name: "Get Started" }));
  await screen.findByText(STEP_ONE_HEADING);
  mockTrackFTUEStep.mockClear();
  return user;
};

/** Presses Continue up to `target`, waiting for each step to land. */
const continueTo = async (
  user: ReturnType<typeof userEvent.setup>,
  target: "two" | "three" | "four",
) => {
  await user.click(continueButton());
  await screen.findByLabelText("Step two field");
  if (target === "two") {
    return;
  }
  await user.click(continueButton());
  await screen.findByLabelText("Step three field");
  if (target === "three") {
    return;
  }
  await user.click(continueButton());
  await screen.findByLabelText("Preferred Name");
};

/** Lets any already-queued submit finish, so "did not fire" is not vacuous. */
const drain = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("onboarding wizard - the form", () => {
  it("is one real form, with native validation off", async () => {
    await startWizard();

    const form = screen.getByRole("form", { name: "Profile setup" });
    expect(form).toBeInstanceOf(HTMLFormElement);
    // `min="1"` on the seat field is what this guards: with native validation
    // on, the browser refuses the submit before `handleNextStep` runs.
    expect((form as HTMLFormElement).noValidate).toBe(true);
    // Continue is the form's submit button.
    expect(continueButton()).toHaveAttribute("type", "submit");
    expect(form).toContainElement(continueButton());
  });

  it("moves one step for Get Started, not two", async () => {
    // Get Started sits inside the form and carries its own `onClick`. Untyped,
    // it would also submit, and `handleNextStep` would run twice on one press.
    const user = userEvent.setup();
    render(<Setup />);

    await user.click(screen.getByRole("button", { name: "Get Started" }));
    await drain();

    expect(screen.getByText(STEP_ONE_HEADING)).toBeInTheDocument();
    expect(screen.queryByLabelText("Step two field")).not.toBeInTheDocument();
    expect(mockTrackFTUEStep).toHaveBeenCalledTimes(1);
    expect(mockTrackFTUEStep).toHaveBeenCalledWith(0);
  });

  it("moves one step for a click on Continue, not two", async () => {
    // The mirror of the test above: Continue submits the form now, so an
    // `onClick` left on it would run the gate twice.
    const user = await startWizard();

    await user.click(continueButton());
    await screen.findByLabelText("Step two field");
    await drain();

    expect(screen.queryByLabelText("Step three field")).not.toBeInTheDocument();
    expect(mockTrackFTUEStep).toHaveBeenCalledTimes(1);
    expect(mockTrackFTUEStep).toHaveBeenCalledWith(1);
  });
});

describe("onboarding wizard - the virtual keyboard's Enter key", () => {
  // Only the attribute is observable in jsdom; whether a phone then shows a
  // Next or Done key needs a device.
  it("is labelled Next on the seat field", async () => {
    await startWizard();

    expect(seatInput()).toHaveAttribute("enterkeyhint", "next");
  });

  it("is labelled Done on the final step's single-line fields", async () => {
    const user = await startWizard();
    await continueTo(user, "four");

    expect(screen.getByLabelText("Preferred Name")).toHaveAttribute(
      "enterkeyhint",
      "done",
    );
    // By id, not by label: the pronouns label is misspelled in `StepFour`, and
    // this test is about the attribute rather than that text.
    expect(document.getElementById("pronouns")).toHaveAttribute(
      "enterkeyhint",
      "done",
    );
  });
});

describe("onboarding wizard - Enter in a field is Continue", () => {
  it("advances from step 1 when the seat count is valid", async () => {
    const user = await startWizard();

    await user.click(seatInput());
    await user.keyboard("{Enter}");

    expect(await screen.findByLabelText("Step two field")).toBeInTheDocument();
    await drain();
    expect(mockTrackFTUEStep).toHaveBeenCalledTimes(1);
    expect(mockTrackFTUEStep).toHaveBeenCalledWith(1);
  });

  it("is stopped by the same gate when the seat count is 0", async () => {
    const user = await startWizard();

    await user.clear(seatInput());
    await user.type(seatInput(), "0");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Seat availability must be > 0",
    );
    expect(seatInput()).toHaveFocus();
    expect(screen.getByText(STEP_ONE_HEADING)).toBeInTheDocument();
    expect(screen.queryByLabelText("Step two field")).not.toBeInTheDocument();
    expect(mockTrackFTUEStep).not.toHaveBeenCalled();
  });

  it("reaches the gate on a click with a seat count of 0, not the browser's tooltip", async () => {
    // `min="1"` makes 0 invalid to the platform. With `noValidate` gone, jsdom
    // - like a browser - stops a submit-button click there, and the
    // announced error below never appears.
    const user = await startWizard();

    await user.clear(seatInput());
    await user.type(seatInput(), "0");
    expect(seatInput()).toBeInvalid();
    await user.click(continueButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Seat availability must be > 0",
    );
    expect(seatInput()).toHaveFocus();
  });

  it("advances from step 2", async () => {
    const user = await startWizard();
    await continueTo(user, "two");
    mockTrackFTUEStep.mockClear();

    await user.click(screen.getByLabelText("Step two field"));
    await user.keyboard("{Enter}");

    expect(
      await screen.findByLabelText("Step three field"),
    ).toBeInTheDocument();
    await drain();
    expect(mockTrackFTUEStep).toHaveBeenCalledTimes(1);
    expect(mockTrackFTUEStep).toHaveBeenCalledWith(2);
  });

  it("does not advance from a read-only input, which belongs to its picker", async () => {
    // Stands in for an antd picker: Enter on it opens or confirms the panel,
    // and must not also move the wizard on.
    const user = await startWizard();
    await continueTo(user, "three");
    mockTrackFTUEStep.mockClear();

    // Positive control: Enter in the editable field beside it *does* advance,
    // so a pass below cannot be a wizard that ignores Enter altogether.
    await user.click(screen.getByLabelText("Step three picker"));
    await user.keyboard("{Enter}");
    await drain();

    expect(screen.getByLabelText("Step three field")).toBeInTheDocument();
    expect(screen.queryByLabelText("Preferred Name")).not.toBeInTheDocument();
    expect(mockTrackFTUEStep).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText("Step three field"));
    await user.keyboard("{Enter}");
    expect(await screen.findByLabelText("Preferred Name")).toBeInTheDocument();
  });
});

describe("onboarding wizard - the final step", () => {
  it("completes onboarding exactly once on Enter", async () => {
    const user = await startWizard();
    await continueTo(user, "four");

    await user.click(screen.getByLabelText("Preferred Name"));
    await user.keyboard("Sam{Enter}");

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    // Drained rather than trusted: a second submit would be queued behind the
    // first, and a count read the instant the first lands cannot see it.
    await drain();
    await drain();

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser.mock.calls[0][0].userInfo).toMatchObject({
      preferredName: "Sam",
      role: "DRIVER",
      seatAvail: 2,
    });
  });

  it("completes onboarding exactly once on a click of Complete", async () => {
    const user = await startWizard();
    await continueTo(user, "four");

    await user.click(screen.getByRole("button", { name: "Complete" }));

    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    await drain();
    await drain();

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it("keeps Enter in the bio as a newline", async () => {
    const user = await startWizard();
    await continueTo(user, "four");
    const bio = screen.getByLabelText("About Me");

    await user.click(bio);
    await user.keyboard("first{Enter}second");
    await drain();

    // The positive control is the newline itself: the key reached the
    // textarea and did its usual job, and the form did not take it.
    expect(bio).toHaveValue("first\nsecond");
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});

describe("onboarding wizard - Previous", () => {
  it("goes back a step on the final step without submitting", async () => {
    const user = await startWizard();
    await continueTo(user, "four");
    mockTrackFTUEStep.mockClear();

    await user.click(screen.getByRole("button", { name: "Previous" }));

    // Positive control: the step index really decreased, so the absence of a
    // write below is not a button that never rendered or never did anything.
    expect(
      await screen.findByLabelText("Step three field"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Preferred Name")).not.toBeInTheDocument();
    await drain();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockTrackFTUEStep).not.toHaveBeenCalled();
  });

  it("goes back a step in the middle of the wizard without advancing", async () => {
    const user = await startWizard();
    await continueTo(user, "three");
    mockTrackFTUEStep.mockClear();

    await user.click(screen.getByRole("button", { name: "Previous" }));

    expect(await screen.findByLabelText("Step two field")).toBeInTheDocument();
    expect(screen.queryByLabelText("Step three field")).not.toBeInTheDocument();
    await drain();
    expect(mockTrackFTUEStep).not.toHaveBeenCalled();
  });
});
