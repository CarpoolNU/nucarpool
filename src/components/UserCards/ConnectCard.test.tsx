import { render, screen } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import { ConnectCard, ConnectCardVariant } from "./ConnectCard";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * How a discovery card is activated, at each viewport.
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
 * Phase 4 converts `isMobile` ternaries to `desktop:` classes, and
 * a class cannot express "pass a different handler" — so this file exists
 * partly to make sure that conversion cannot quietly swallow the distinction.
 * It is the reason this ticket is sequenced before that one.
 *
 * *What this does not cover:* nothing here asserts geometry. See
 * `testing/viewport.ts` for what jsdom can and cannot tell you — in short, a
 * control being in the tree, not where it lands on a screen.
 */

/**
 * The one procedure a test here asserts against by name, rather than stubbing
 * to keep a render from throwing. `mock`-prefixed so `jest.mock`'s hoisting
 * allows the reference.
 */
const mockCreateRequest = jest.fn();

/**
 * The mock below discards the `useMutation` options object it is called
 * with, so `onSuccess` - which is where `ConnectModal` flips to its "request
 * sent" screen - is otherwise unreachable from a test. This holder captures
 * it at render time so a test can invoke it directly, the same way the real
 * mutation's response would.
 */
const mockRequestOnSuccessHolder: {
  onSuccess?: (request: { id: string }, variables: { message: string }) => void;
} = {};

/**
 * `UserCard` favourites through a mutation and reads `trpc.useUtils()`. The
 * subject here is which handler the card is given, so the client is mocked as
 * a shape rather than driven through a real provider — the precedent is
 * `GroupPage.test.tsx`.
 *
 * `requests.create` and `emails.sendRequestNotification` are here because
 * pressing Connect mounts `ConnectModal`, which calls both hooks at render.
 * Only the first is asserted on; the second would throw if absent.
 */
jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: () => ({
      user: {
        recommendations: { me: { invalidate: jest.fn() } },
        requests: { me: { invalidate: jest.fn() } },
      },
    }),
    user: {
      favorites: { edit: { useMutation: () => ({ mutate: jest.fn() }) } },
      requests: {
        create: {
          useMutation: (opts: {
            onSuccess?: (
              request: { id: string },
              variables: { message: string },
            ) => void;
          }) => {
            mockRequestOnSuccessHolder.onSuccess = opts?.onSuccess;
            return {
              mutate: mockCreateRequest,
              isPending: false,
            };
          },
        },
      },
      emails: {
        sendRequestNotification: {
          useMutation: () => ({ mutate: jest.fn() }),
        },
      },
    },
  },
}));

/** Avatars resolve through a presigned-URL query; irrelevant here. */
jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

restoreViewportAfterEach();

beforeEach(() => {
  mockCreateRequest.mockClear();
});

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
    variant?: ConnectCardVariant;
    user?: User;
  } = {},
) =>
  render(
    <UserContext.Provider value={overrides.user ?? VIEWER}>
      <ConnectCard
        otherUser={OTHER_USER}
        onViewRouteClick={() => undefined}
        onViewRequest={() => undefined}
        variant={overrides.variant}
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
    // only on the card the sheet expanded, so it is the mobile counterpart of
    // the right-hand Connect button the full card carries.
    renderCard({ variant: "detail" });

    expect(
      screen.getByRole("button", { name: "Connect!" }),
    ).toBeInTheDocument();
  });

  it("collapses back to the list once a sent request's sheet is closed", async () => {
    // A sent request drops its recipient out of `recommendations.me` - the
    // router excludes anyone with an open request - so the detail sheet,
    // scoped to this one card, would otherwise be left rendering nothing:
    // the blank tab this test pins. `handleMobileExpand` with no id is the
    // same collapse the header's Back button performs.
    const handleMobileExpand = jest.fn();
    renderCard({ variant: "detail", handleMobileExpand });

    await userEvent.click(screen.getByRole("button", { name: "Connect!" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    act(() => {
      mockRequestOnSuccessHolder.onSuccess?.({ id: "req-1" }, { message: "" });
    });

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(handleMobileExpand).toHaveBeenCalledWith();
  });

  it("leaves the sheet as-is when the compose step is cancelled", async () => {
    // Cancelling before sending is not the case this ticket is about - the
    // reader has not connected with anyone, so there is no reason to leave
    // the card they were looking at.
    const handleMobileExpand = jest.fn();
    renderCard({ variant: "detail", handleMobileExpand });

    await userEvent.click(screen.getByRole("button", { name: "Connect!" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(handleMobileExpand).not.toHaveBeenCalled();
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

  /*
   * A test stood here once, named "does not offer the mobile
   * condensed Connect". It rendered at a desktop width with
   * `mobileSelectedUser` set and asserted the condensed Connect stayed away,
   * pinning the `isMobile` term the gate carried because page state could
   * outlive the viewport that produced it.
   *
   * Its setup is now unreachable: `index.tsx` derives the prop through
   * `resolveMobileSelectedUser`, so a desktop render never receives a non-null
   * value. What is left of the desktop contract - two visibly labelled
   * controls and no full-card overlay - is the test above, and the invariant
   * itself is tested in `utils/explore/exploreSidebarView.test.ts`.
   */
});

describe("The card a map pin opens, at a mobile viewport", () => {
  /**
   * **This block asserted the defect as correct behaviour.** It rendered
   * `ConnectCard` with no selection prop - which was exactly how
   * `MapConnectPortal` rendered it - and required that no `Connect!` appear.
   * Its own comment read the surviving `Seats Available:` row as proof that
   * "the full layout is intact", but that is an *info* row. The row carrying
   * the actions is `UserCard`'s, and `!isMobile` had already removed it, so
   * the presence of one said nothing about the other. A mobile pin tap opened
   * a card with the favourite star and a close button and nothing else.
   *
   * The concern it was written for - an unselected card claiming to *be* the
   * selection, because `undefined !== null` - no longer has a prop to arise
   * from: `variant` names the surface instead, and a card given none is a list
   * card. "Stays inert when no expand handler is supplied" above still pins
   * that, and more strictly, by allowing no controls at all.
   */
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("offers Connect, which the desktop-only button row cannot supply", () => {
    renderCard({ variant: "portal" });

    expect(
      screen.getByRole("button", { name: "Connect!" }),
    ).toBeInTheDocument();
  });

  it("opens the connect modal when it is pressed", async () => {
    // Present is not the same as wired. A button that rendered while
    // `connectAction` refused would satisfy a presence assertion and still
    // leave the user with nothing that happens.
    renderCard({ variant: "portal" });

    await userEvent.click(screen.getByRole("button", { name: "Connect!" }));

    expect(
      screen.getByRole("heading", { name: "Send a message to connect!" }),
    ).toBeInTheDocument();
  });

  it("sends the request for the user whose pin was tapped", async () => {
    // The end of the path the ticket says is a dead end, and the `toId` is
    // the part worth pinning: the portal renders one card per user at the
    // tapped location, so a control wired to the wrong one would connect the
    // reader to somebody they did not choose.
    renderCard({ variant: "portal" });

    await userEvent.click(screen.getByRole("button", { name: "Connect!" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mockCreateRequest).toHaveBeenCalledWith({
      toId: OTHER_USER.id,
      message: "",
    });
  });

  it("keeps the detail rows the condensed sheet drops", () => {
    // The reason this is `portal` rather than reusing `detail`. Passing the
    // explore sheet's selection id from the portal - the alternative this
    // ticket weighed - would have added the button and taken these rows with
    // it, because `isMobileCondensedLayout` reads the same value. The pin
    // sheet is where the user decides whether this person is worth
    // connecting with, so the schedule and the seats are the point.
    renderCard({ variant: "portal" });

    expect(screen.getByText("Seats Available:")).toBeInTheDocument();
    expect(screen.getByText("Job Start:")).toBeInTheDocument();
  });

  it("goes inert, and says why, for a reader who cannot send a request", () => {
    // Disabled rather than absent, which is the distinction worth pinning: a
    // control that vanished in Viewer mode would leave the card looking
    // exactly like the pre-fix one this ticket is about, and the reader would
    // have no idea why.
    //
    // Two independent conditions disable it here - `role === "VIEWER"` and a
    // non-null `unavailable`, because `carpoolUnavailableExplanation` refuses
    // a VIEWER reader as well. Removing either one on its own leaves this
    // green, which is deliberate: the criterion is that the control is inert
    // and explained, not which clause got there first.
    renderCard({
      variant: "portal",
      user: { ...VIEWER, role: Role.VIEWER } as User,
    });

    expect(screen.getByRole("button", { name: "Connect!" })).toBeDisabled();
    expect(screen.getByText(/You are in Viewer mode/)).toBeInTheDocument();
  });

  it("makes no part of the card an expand target", () => {
    // There is nothing to expand to - the portal is already the detail view -
    // and a stretched activation button would sit under the star and the
    // Connect control, which is the nesting bug that was fixed once already.
    renderCard({ variant: "portal" });

    expect(
      screen.queryByRole("button", { name: ACTIVATION }),
    ).not.toBeInTheDocument();
  });
});
