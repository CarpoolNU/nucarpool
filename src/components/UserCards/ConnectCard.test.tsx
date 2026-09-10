import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import { ConnectCard } from "./ConnectCard";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * How a discovery card is activated, at each viewport (SCRUM-416).
 *
 * `ConnectCard` is the one place in the app that deliberately hands a
 * *different* interaction to each platform rather than styling one two ways:
 * tapping the card body expands it on mobile, and on desktop the card body is
 * not interactive at all. Both halves of that were untested, and both are
 * easy to break in a way nothing else would notice:
 *
 *  - lose the mobile branch and tapping a card on a phone does nothing, which
 *    is the same class of defect as phase 3's unreachable filter button;
 *  - lose the *desktop* branch by passing a no-op instead of `undefined` and
 *    `UserCard` renders its stretched activation button over every desktop
 *    card, swallowing clicks meant for Connect and the favourite star. That
 *    regression has no visible symptom until someone tries to click something.
 *
 * Phase 4 (SCRUM-415) converts `isMobile` ternaries to `desktop:` classes, and
 * a class cannot express "pass a different handler" — so this file exists
 * partly to make sure that conversion cannot quietly swallow the distinction.
 * It is the reason this ticket is sequenced before that one.
 *
 * *What this does not cover:* nothing here asserts geometry. See
 * `testing/viewport.ts` for what jsdom can and cannot tell you — in short, a
 * control being in the tree, not where it lands on a screen.
 */

/**
 * `src/utils/mixpanel.ts` calls `mixpanel.init(...)` at module scope, so
 * importing it starts analytics and logs a page of debug output per run.
 * Mocked for the same reason `ExploreSidebar.test.tsx` mocks it.
 */
jest.mock("../../utils/mixpanel", () => ({
  trackEvent: jest.fn(),
  trackViewRoute: jest.fn(),
}));

/**
 * `UserCard` favourites through a mutation and reads `trpc.useUtils()`. The
 * subject here is which handler the card is given, so the client is mocked as
 * a shape rather than driven through a real provider — the precedent is
 * `GroupPage.test.tsx`.
 */
jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: { recommendations: { me: { invalidate: jest.fn() } } },
    }),
    user: {
      favorites: { edit: { useMutation: () => ({ mutate: jest.fn() }) } },
    },
  },
}));

/** Avatars resolve through a presigned-URL query; irrelevant here. */
jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

restoreViewportAfterEach();

const OTHER_USER = {
  id: "other-1",
  name: "Riley Other",
  preferredName: "Riley",
  pronouns: "they/them",
  bio: "",
  image: null,
  role: Role.DRIVER,
  status: Status.ACTIVE,
  seatAvail: 3,
  companyName: "Acme",
  startAddress: "1 Somewhere St",
  startCoordLng: -71.09,
  startCoordLat: 42.34,
  companyAddress: "2 Elsewhere Ave",
  companyCoordLng: -71.08,
  companyCoordLat: 42.35,
  daysWorking: "1,1,1,1,1,0,0",
  startTime: new Date("2026-01-05T13:00:00.000Z"),
  endTime: new Date("2026-01-05T22:00:00.000Z"),
  coopStartDate: new Date("2026-01-05T00:00:00.000Z"),
  coopEndDate: new Date("2026-06-30T00:00:00.000Z"),
  carpoolId: null,
  isFavorited: false,
} as unknown as EnhancedPublicUser;

/**
 * A RIDER viewer, so `carpoolUnavailableExplanation` finds a DRIVER with seats
 * compatible and the card stays actionable. An incompatible pair would render
 * the notice instead and take the Connect affordance inert, which is a
 * different test's subject.
 */
const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
} as unknown as User;

/** The activation button's accessible name, built from `preferredName`. */
const ACTIVATION = "Show Riley's full details";

const renderCard = (
  overrides: {
    handleMobileExpand?: (userId?: string) => void;
    mobileSelectedUser?: string | null;
  } = {},
) =>
  render(
    <UserContext.Provider value={VIEWER}>
      <ConnectCard
        otherUser={OTHER_USER}
        onViewRouteClick={() => undefined}
        onViewRequest={() => undefined}
        mobileSelectedUser={overrides.mobileSelectedUser ?? null}
        handleMobileExpand={overrides.handleMobileExpand}
      />
    </UserContext.Provider>,
  );

describe("Discovery card activation on mobile", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("makes the card body a named control", () => {
    renderCard({ handleMobileExpand: () => undefined });

    // Named, not just present: `UserCard`'s activation button has no text of
    // its own, so without `onClickLabel` it is an unnamed control. Querying by
    // role *and* name is what pins both halves of that pair.
    expect(
      screen.getByRole("button", { name: ACTIVATION }),
    ).toBeInTheDocument();
  });

  it("expands the tapped user, by id", async () => {
    const handleMobileExpand = jest.fn();
    renderCard({ handleMobileExpand });

    await userEvent.click(screen.getByRole("button", { name: ACTIVATION }));

    // The id matters: the handler takes an optional `userId` and calling it
    // with nothing is the *collapse* path, so a card that expanded "whichever
    // user" would pass a looser assertion.
    expect(handleMobileExpand).toHaveBeenCalledWith(OTHER_USER.id);
  });

  it("stays inert when no expand handler is supplied", () => {
    // A card that invented an activation anyway would put an unresponsive
    // full-card button over the whole thing.
    //
    // Asserted as "no controls at all" rather than "not this label", because a
    // no-op activation carrying a *different* label passes the label form -
    // that exact mutation survived an earlier version of this file.
    renderCard();

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers Connect once the card is expanded", () => {
    // The condensed detail view's own action. It exists only on mobile and
    // only while a card is selected, so it is the mobile counterpart of the
    // right-hand Connect button the full card carries.
    renderCard({ mobileSelectedUser: OTHER_USER.id });

    expect(
      screen.getByRole("button", { name: "Connect!" }),
    ).toBeInTheDocument();
  });
});

describe("Discovery card activation on desktop", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("leaves the card body non-interactive", () => {
    // `ConnectCard` passes `undefined` rather than a no-op precisely so that
    // *no button exists*, and the failure mode of getting that wrong is
    // silent: an invisible button stretched across the card, swallowing every
    // click aimed at the controls inside it.
    //
    // Stated absolutely, because both weaker forms let the real regression
    // through and both were tried here first. Asserting the absence of one
    // accessible name misses a no-op activation carrying any other label.
    // Comparing button counts against a card rendered without a handler
    // misses it too - on desktop *neither* render takes the mobile branch, so
    // the mutation adds a button to the baseline as well and the counts still
    // match.
    renderCard({ handleMobileExpand: () => undefined });

    const labels = screen.getAllByRole("button").map((b) => b.textContent);

    expect(labels).toEqual(["View Route", "Connect"]);
    // The activation overlay is the only button in a card with no text of its
    // own - it is a bare `<button />` carrying an `aria-label`. So "every
    // control here is visibly labelled" is the property that rules it out
    // whatever label it might have been given.
    expect(labels).not.toContain("");
  });

  it("does not offer the mobile condensed Connect", () => {
    // `mobileSelectedUser` is page state, not viewport state, so it can be
    // non-null on desktop after a resize. The gate has to test both.
    renderCard({ mobileSelectedUser: OTHER_USER.id });

    expect(
      screen.queryByRole("button", { name: "Connect!" }),
    ).not.toBeInTheDocument();
  });
});
