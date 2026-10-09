/**
 * Each wizard step is a conditional render, so the control that held focus when
 * the step changed - the field Enter was pressed in, Get Started, Previous - is
 * unmounted with the step it belonged to, and focus falls to `<body>`. Since
 * Enter in a field advances the wizard, the next Enter would then do nothing
 * and the user would have to Tab back in from the top of the page.
 *
 * So the card (`SetupContainer`) takes focus when the step changes. It is a
 * named group, so every assertion below finds it by role and name - which pins
 * the announcement as well as the focus.
 *
 * **Every advance here is `user.keyboard("{Enter}")` on a focused field**, for
 * the reason `setupImplicitSubmission.test.tsx` gives. A click on Continue is
 * covered too, but only as the control: that button survives a step change, so
 * it cannot lose focus this way.
 *
 * Deliberately not co-located under `src/pages/`, for the reason
 * `setupNavigationPlacement.test.tsx` gives: a test file there is also a route.
 */

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("../../pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));

jest.mock("next/router", () =>
  require("../../testing/nextRouterStub").buildRouterMock(),
);
jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);

/**
 * A DRIVER with every later step's data already valid, so each gate passes and
 * the only thing under test is where focus goes afterwards. Held in a constant
 * because `user` is an effect dependency on the page.
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
jest.mock("../../utils/profile/updateUser", () => ({
  updateUser: jest.fn(),
  useEditUserMutation: () => ({ mutate: jest.fn(), mutateAsync: jest.fn() }),
}));

/*
 * Steps 2 to 4 are stubbed to a bare input each. Their fields are covered where
 * they live; what matters here is that there is a field to hold focus on the
 * old step and a field to type into on the new one. Stubbing them is also what
 * makes the card the right place for the behaviour: a focus target inside a
 * step component would do nothing under these stubs, and a step added later
 * could forget it.
 */
jest.mock("../../components/Setup/StepTwo", () => ({
  __esModule: true,
  default: () => <input aria-label="Step two field" />,
}));
jest.mock("../../components/Setup/StepThree", () => ({
  __esModule: true,
  default: () => <input aria-label="Step three field" />,
}));
jest.mock("../../components/Setup/StepFour", () => ({
  __esModule: true,
  default: () => <input aria-label="Step four field" />,
}));
jest.mock("../../components/Setup/ProgressBar", () => ({
  __esModule: true,
  default: () => <div>progress</div>,
}));

import Setup from "../../pages/profile/setup";

const seatInput = () =>
  screen.getByRole("spinbutton", { name: /seat availability/i });
const continueButton = () => screen.getByRole("button", { name: "Continue" });

/** The card as a screen reader meets it: a group named for the step. */
const stepCard = (n: 1 | 2 | 3 | 4) =>
  screen.getByRole("group", { name: new RegExp(`^Step ${n} of 4`) });

/** Lets any queued effect or submit finish, so "did not move" is not vacuous. */
const drain = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** Renders the wizard and presses Get Started, which lands on step 1. */
const startWizard = async () => {
  const user = userEvent.setup();
  render(<Setup />);
  await user.click(screen.getByRole("button", { name: "Get Started" }));
  await screen.findByRole("group", { name: /^Step 1 of 4/ });
  return user;
};

/** Presses Enter in each step's field up to `target`. */
const enterTo = async (
  user: ReturnType<typeof userEvent.setup>,
  target: "two" | "three" | "four",
) => {
  await user.click(seatInput());
  await user.keyboard("{Enter}");
  await screen.findByLabelText("Step two field");
  if (target === "two") {
    return;
  }
  await user.click(screen.getByLabelText("Step two field"));
  await user.keyboard("{Enter}");
  await screen.findByLabelText("Step three field");
  if (target === "three") {
    return;
  }
  await user.click(screen.getByLabelText("Step three field"));
  await user.keyboard("{Enter}");
  await screen.findByLabelText("Step four field");
};

describe("onboarding wizard - focus after a successful advance", () => {
  it("lands inside the new step after Enter from the seat field", async () => {
    const user = await startWizard();

    // Positive control: focus really is on the old step's field, so the
    // assertion below is about a move and not about focus that never left.
    await user.click(seatInput());
    expect(seatInput()).toHaveFocus();

    await user.keyboard("{Enter}");
    const field = await screen.findByLabelText("Step two field");

    expect(stepCard(2)).toHaveFocus();
    expect(stepCard(2)).toContainElement(field);
    expect(document.body).not.toHaveFocus();
  });

  it("does the same from each later step", async () => {
    const user = await startWizard();
    await enterTo(user, "two");
    expect(stepCard(2)).toHaveFocus();

    await user.click(screen.getByLabelText("Step two field"));
    expect(screen.getByLabelText("Step two field")).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByLabelText("Step three field");
    expect(stepCard(3)).toHaveFocus();

    await user.click(screen.getByLabelText("Step three field"));
    await user.keyboard("{Enter}");
    await screen.findByLabelText("Step four field");
    expect(stepCard(4)).toHaveFocus();
  });

  it("makes the next Tab reach the new step's first field", async () => {
    // The user-visible point: after an Enter-driven advance the
    // very next Tab reaches the new step's first field, rather than starting
    // again from the top of the document.
    const user = await startWizard();
    await user.click(seatInput());
    await user.keyboard("{Enter}");
    await screen.findByLabelText("Step two field");

    await user.tab();

    expect(screen.getByLabelText("Step two field")).toHaveFocus();
  });

  it("lands inside the new step after a click on Continue", async () => {
    const user = await startWizard();

    await user.click(continueButton());
    await screen.findByLabelText("Step two field");

    expect(stepCard(2)).toHaveFocus();
  });

  it("lands inside step 1 after Get Started", async () => {
    // Get Started is removed when step 0 becomes step 1, so it has the same
    // shape as the field: focus is on a control that no longer exists.
    const user = userEvent.setup();
    render(<Setup />);
    const getStarted = screen.getByRole("button", { name: "Get Started" });
    await user.click(getStarted);
    await screen.findByRole("group", { name: /^Step 1 of 4/ });

    expect(getStarted).not.toBeInTheDocument();
    expect(stepCard(1)).toHaveFocus();
  });

  it("names the step, so a screen reader announces where focus went", async () => {
    const user = await startWizard();
    await enterTo(user, "two");

    expect(stepCard(2)).toHaveAccessibleName(
      "Step 2 of 4: Where are you carpooling?",
    );
  });
});

describe("onboarding wizard - focus after Previous", () => {
  it("lands inside step 1 when Previous leaves step 2", async () => {
    // The Previous button is rendered only while `step > 1`, so going back to
    // step 1 unmounts the very button that was pressed.
    const user = await startWizard();
    await enterTo(user, "two");
    const previous = screen.getByRole("button", { name: "Previous" });

    await user.click(previous);
    await screen.findByLabelText("Seat Availability");

    expect(previous).not.toBeInTheDocument();
    expect(stepCard(1)).toHaveFocus();
  });

  it("lands inside the step returned to from a later step", async () => {
    const user = await startWizard();
    await enterTo(user, "three");

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByLabelText("Step two field");

    expect(stepCard(2)).toHaveFocus();
  });
});

describe("onboarding wizard - focus is left alone when the step does not change", () => {
  it("does not take focus on the first render", async () => {
    render(<Setup />);
    await drain();

    expect(document.body).toHaveFocus();
    expect(
      screen.getByRole("group", { name: "Welcome to CarpoolNU" }),
    ).not.toHaveFocus();
  });

  it("does not pull focus back from a field on a re-render", async () => {
    const user = await startWizard();
    await enterTo(user, "two");
    expect(stepCard(2)).toHaveFocus();

    // Positive control: focus moves off the card onto the field...
    await user.click(screen.getByLabelText("Step two field"));
    expect(screen.getByLabelText("Step two field")).toHaveFocus();

    // ...and typing re-renders the page (`watch` and `errors` subscriptions)
    // without changing the step, so a card that took focus on every render
    // would show here.
    await user.keyboard("abc");
    await drain();

    expect(screen.getByLabelText("Step two field")).toHaveFocus();
    expect(stepCard(2)).not.toHaveFocus();
  });

  it("still focuses the invalid field, not the card, when the gate fails", async () => {
    // A failed gate returns before `setStep`, so the step does not change and
    // the card has no reason to take focus.
    const user = await startWizard();

    await user.clear(seatInput());
    await user.type(seatInput(), "0");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Seat availability must be > 0",
    );
    await drain();

    expect(seatInput()).toHaveFocus();
    expect(stepCard(1)).not.toHaveFocus();
    expect(screen.queryByLabelText("Step two field")).not.toBeInTheDocument();
  });
});
