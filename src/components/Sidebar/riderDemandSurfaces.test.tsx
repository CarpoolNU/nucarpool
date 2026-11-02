/**
 * Where the rider-demand notice appears, and the three places it must not.
 *
 * SCRUM-638 settled two surfaces: the empty recommendations list, and the
 * role selector on the profile. Both are covered here, in one file, because
 * what is actually being asserted is a single rule read from two sides —
 * *this* moment carries the notice and the neighbouring ones do not — and
 * splitting it would let one half drift while the other kept passing.
 *
 * The ticket asks specifically for the below-floor and zero cases "most
 * likely to be skipped and most likely to look broken". They are the bulk of
 * this file. Each is paired with a positive control in the same harness,
 * because an absent notice is also what a broken component renders.
 *
 * `RiderDemandNotice` itself is **not** mocked. Its own suite covers its
 * internals; the question here is whether the surfaces hand it the right
 * things, which a stub standing in for it could not answer.
 */

import { render, screen } from "@testing-library/react";
import { Role, Status } from "@prisma/client";
import { useForm } from "react-hook-form";
import { SidebarContent } from "./SidebarContent";
import UserSection from "../Profile/UserSection";
import { UserContext } from "../../utils/userContext";
import {
  EnhancedPublicUser,
  OnboardingFormInputs,
  User,
} from "../../utils/types";
import { QueryState } from "../../utils/queryState";
import { RIDER_DEMAND_FLOOR } from "../../utils/riderDemand/floor";

jest.mock("next-auth/react", () =>
  require("../../testing/nextAuthStub").buildNextAuthMock(),
);

jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

/**
 * The recommendation card, which reaches for a tRPC context this file does
 * not provide. Only one test renders a non-empty list, and its subject is
 * that the notice is *absent* - what the cards themselves look like is
 * `ConnectCard`'s own business.
 */
jest.mock("../UserCards/ConnectCard", () => ({
  ConnectCard: () => <div data-testid="connect-card" />,
}));

jest.mock("../../utils/mixpanel", () => ({
  trackRiderDemandShown: jest.fn(),
  trackRiderDemandDismissed: jest.fn(),
}));

/** A count comfortably above the floor, so a visible notice is unambiguous. */
const ABOVE_FLOOR = RIDER_DEMAND_FLOOR + 11;

/** The notice, or null. */
const notice = () => screen.queryByRole("status");

const READY: QueryState = { status: "ready" } as QueryState;

const signedInUser = (role: Role) =>
  ({ id: "me", role, preferredName: "Riley" }) as unknown as User;

beforeEach(() => {
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Surface one: the empty recommendations list.
// ---------------------------------------------------------------------------

const renderSidebar = ({
  subType = "recommendations",
  disabled = false,
  cards = [] as EnhancedPublicUser[],
  riderDemandCount = ABOVE_FLOOR as number | null,
  loadState = READY,
  role = Role.RIDER,
}: {
  subType?: string;
  disabled?: boolean;
  cards?: EnhancedPublicUser[];
  riderDemandCount?: number | null;
  loadState?: QueryState;
  role?: Role;
} = {}) =>
  render(
    <UserContext.Provider value={signedInUser(role)}>
      <SidebarContent
        subType={subType}
        userCardList={cards}
        loadState={loadState}
        disabled={disabled}
        onViewRouteClick={() => undefined}
        onCardClick={() => undefined}
        selectedUser={null}
        onViewRequest={() => undefined}
        riderDemandCount={riderDemandCount}
      />
    </UserContext.Provider>,
  );

describe("the empty recommendations list", () => {
  it("carries the notice when the list came back empty", async () => {
    renderSidebar();

    expect(await screen.findByRole("status")).toHaveTextContent(
      new RegExp(`${ABOVE_FLOOR} riders`),
    );
  });

  it("still says the list is empty, rather than replacing that with the notice", async () => {
    renderSidebar();
    await screen.findByRole("status");

    // The notice is an addition to the empty state, not a substitute. A
    // reader who is shown only a recruitment pitch has lost the information
    // that their search found nobody.
    expect(
      screen.getByText(/unable to find any recommendations/i),
    ).toBeInTheDocument();
  });

  it("carries the notice for a VIEWER, under the Viewer-mode copy", async () => {
    renderSidebar({ disabled: true, role: Role.VIEWER });

    expect(screen.getByText(/currently in Viewer mode/i)).toBeInTheDocument();
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows nothing below the floor", async () => {
    renderSidebar({ riderDemandCount: null });

    expect(
      screen.getByText(/unable to find any recommendations/i),
    ).toBeInTheDocument();
    expect(notice()).toBeNull();

    // Positive control: the same harness does render a notice when there is
    // one, so the assertion above is a measurement rather than a vacuum.
    renderSidebar({ riderDemandCount: ABOVE_FLOOR });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows nothing when the caller supplies no count at all", async () => {
    // Rendered without the prop rather than with `undefined`, because
    // `renderSidebar` would substitute its default for that - the prop is
    // optional, and a caller that has not wired it up is the case here.
    render(
      <UserContext.Provider value={signedInUser(Role.RIDER)}>
        <SidebarContent
          subType="recommendations"
          userCardList={[]}
          loadState={READY}
          disabled={false}
          onViewRouteClick={() => undefined}
          onCardClick={() => undefined}
          selectedUser={null}
          onViewRequest={() => undefined}
        />
      </UserContext.Provider>,
    );

    expect(notice()).toBeNull();

    renderSidebar({ riderDemandCount: ABOVE_FLOOR });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows nothing when the list is not empty", async () => {
    // Someone looking at matches does not need to be told to go and find
    // some. The notice belongs to the dead end, not to the tab.
    const cards = [
      { id: "other", preferredName: "Sam" },
    ] as unknown as EnhancedPublicUser[];
    renderSidebar({ cards });

    expect(notice()).toBeNull();

    renderSidebar({ cards: [] });
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows nothing while the list is still loading or has failed", () => {
    renderSidebar({ loadState: { status: "loading" } as QueryState });
    expect(notice()).toBeNull();

    renderSidebar({
      loadState: { status: "error", retry: () => undefined } as QueryState,
    });
    expect(notice()).toBeNull();
  });

  it.each(["favorites", "sent", "received", "all"])(
    "shows nothing on the %s tab, whose emptiness says nothing about driver supply",
    async (subType) => {
      renderSidebar({ subType });
      expect(notice()).toBeNull();

      renderSidebar({ subType: "recommendations" });
      expect(await screen.findByRole("status")).toBeInTheDocument();
    },
  );
});

// ---------------------------------------------------------------------------
// Surface two: the profile role selector.
// ---------------------------------------------------------------------------

const ProfileHarness = ({
  riderDemandCount,
  role = Role.RIDER,
}: {
  riderDemandCount: number | null;
  role?: Role;
}) => {
  const { register, watch, setValue, handleSubmit, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: {
        role,
        status: Status.ACTIVE,
        preferredName: "Riley",
        pronouns: "",
        bio: "",
        seatAvail: 0,
      },
    });

  return (
    <UserSection
      register={register}
      watch={watch}
      setValue={setValue}
      errors={formState.errors}
      onSubmit={handleSubmit(() => undefined)}
      onPendingPictureChange={() => undefined}
      pendingPicture={null}
      checkChanges={(proceed) => proceed()}
      user={signedInUser(role)}
      riderDemandCount={riderDemandCount}
    />
  );
};

describe("the profile role selector", () => {
  it("carries the notice beside the role radios", async () => {
    render(<ProfileHarness riderDemandCount={ABOVE_FLOOR} />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      new RegExp(`${ABOVE_FLOOR} riders`),
    );
    // The control it argues for is in the same tree, which is the whole
    // reason this surface was chosen over the map.
    expect(screen.getByLabelText("Driver")).toBeInTheDocument();
  });

  it("shows nothing below the floor", async () => {
    render(<ProfileHarness riderDemandCount={null} />);
    expect(notice()).toBeNull();

    render(<ProfileHarness riderDemandCount={ABOVE_FLOOR} />);
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("shows nothing once Driver is selected, before the form is even saved", async () => {
    render(
      <ProfileHarness riderDemandCount={ABOVE_FLOOR} role={Role.DRIVER} />,
    );

    // The reader has done the thing. Continuing to ask reads as nagging,
    // which is the failure mode the ticket names.
    expect(notice()).toBeNull();
  });

  it("carries the notice for a VIEWER, who is a target of the feature", async () => {
    render(
      <ProfileHarness riderDemandCount={ABOVE_FLOOR} role={Role.VIEWER} />,
    );

    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("does not submit the profile form when the notice is dismissed", async () => {
    // The notice renders inside the section's `<form>`. A dismiss button with
    // no explicit `type` would default to `submit` and save the user's whole
    // profile as a side effect of hiding a sentence.
    render(<ProfileHarness riderDemandCount={ABOVE_FLOOR} />);
    await screen.findByRole("status");

    expect(screen.getByRole("button", { name: /dismiss/i })).toHaveAttribute(
      "type",
      "button",
    );
  });
});
