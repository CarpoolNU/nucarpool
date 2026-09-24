import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import { MapConnectPortal } from "./MapConnectPortal";
import { UserContext } from "../../utils/userContext";
import { EnhancedPublicUser, PublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * What a map pin tap opens, and whether it can be closed again.
 *
 * This assertion was written earlier and deferred to this
 * ticket, because the capability did not exist to test: `MapConnectPortal` was
 * `!isMobile`-gated in `index.tsx` while the map's click handlers ran on every
 * platform, so a phone tap set `popupUsers` and nothing rendered - and nothing
 * could clear it again, for the rest of the session. A test for a capability
 * that does not exist is a failing test rather than a guard, so phase 5 left
 * it here.
 *
 * The dismissal half is the point. "Something renders" was never the whole
 * defect: the state being unclearable was the worse half, and it is the half a
 * presence assertion misses entirely.
 *
 * **Whether an opened sheet can be acted on came later**, and is the other
 * reason to read this file. The original seven tests asked only whether the
 * sheet appeared and whether it went away; the card inside it had no Connect
 * control at a phone width and nothing here noticed for a release. "Offers a
 * way to act on the person it is describing" is that gap closed, and the
 * desktop block's "keeps exactly the two controls it had" is the other side of
 * it - the fix is viewport-conditional, so both viewports need an assertion.
 *
 * *Not covered, and not coverable here:* that the sheet clears the bottom
 * navigation, that its height is reasonable, or that it sits above the
 * navigation's `z-index: 100`. jsdom does no layout and computes no stacking -
 * see `src/testing/viewport.ts`. The positioning is arithmetic from that change's
 * tokens, not a measurement, and wants a look on a real phone.
 */

/** Asserted by name below; `mock`-prefixed for `jest.mock`'s hoisting. */
const mockCreateRequest = jest.fn();

/**
 * `requests.create` and `emails.sendRequestNotification` joined this shape
 * when the sheet gained a Connect control: pressing it mounts `ConnectModal`,
 * which calls both hooks at render.
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
      blocks: {
        block: { useMutation: () => ({ mutate: jest.fn(), isPending: false }) },
      },
      requests: {
        create: {
          useMutation: () => ({
            mutate: mockCreateRequest,
            isPending: false,
          }),
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

jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({ profileImageUrl: null, isLoading: false }),
}));

restoreViewportAfterEach();

beforeEach(() => {
  mockCreateRequest.mockClear();
});

const PIN_USER = {
  id: "pin-1",
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
} as unknown as PublicUser;

/** A RIDER viewer, so a DRIVER pin is compatible and no notice renders. */
const VIEWER = {
  id: "viewer-1",
  role: Role.RIDER,
  status: Status.ACTIVE,
  seatAvail: 0,
} as unknown as User;

const renderPortal = (
  overrides: { otherUsers?: PublicUser[] | null; onClose?: () => void } = {},
) => {
  const onClose = overrides.onClose ?? jest.fn();

  render(
    <UserContext.Provider value={VIEWER}>
      <MapConnectPortal
        otherUsers={
          overrides.otherUsers === undefined ? [PIN_USER] : overrides.otherUsers
        }
        extendUser={(user) => user as EnhancedPublicUser}
        onViewRouteClick={() => undefined}
        onViewRequest={() => undefined}
        onClose={onClose}
      />
    </UserContext.Provider>,
  );

  return { onClose };
};

describe("a map pin tap at a mobile viewport", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("opens something showing the tapped user", () => {
    /*
     * **This one passes before the fix as well, and saying so matters.** The
     * defect was the `!isMobile` gate in `index.tsx`; this suite renders the
     * component directly, so it never sees that gate. The old component had no
     * viewport logic at all and rendered its cards whenever it was given any,
     * so of course it satisfies this.
     *
     * What is genuinely covered below is the component's half of the contract -
     * that a mobile render carries a control able to clear the selection - and
     * that is what could regress. The gate's removal is verified by reading the
     * diff, because `index.tsx` has no test: it is ~1300 lines behind Mapbox,
     * NextAuth and a dozen tRPC queries, which is the same reason earlier work
     * had for lifting decisions out of it. There is no decision left here to
     * lift - the answer is now "always render" - so there is nothing to make
     * pure and test.
     */
    renderPortal();

    expect(screen.getByText("Riley")).toBeInTheDocument();
  });

  it("offers a control that dismisses it", () => {
    renderPortal();

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("clears the pin selection when that control is used", async () => {
    // The half that matters. `onClose` is the page's `setPopupUsers(null)`, so
    // this is the assertion that the stuck-state defect is actually gone - a
    // sheet that rendered but could not call this would leave `popupUsers`
    // non-null exactly as before.
    const { onClose } = renderPortal();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays shut when no pin is selected", () => {
    // Guards the other direction: a sheet keyed off the wrong condition would
    // sit open over the map permanently.
    renderPortal({ otherUsers: null });

    expect(screen.queryByText("Riley")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });

  it("offers a way to act on the person it is describing", async () => {
    /*
     * The assertion this suite was missing, and the one the sheet failed.
     * Seven tests covered whether it opened and whether it closed; none asked
     * whether the card inside it could be *used*. It could not: `UserCard`'s
     * `View Route` + `Connect` row is behind `!isMobile`, the replacement
     * `Connect!` was behind a prop this component does not pass, and no
     * card-tap path existed to turn either on. A user tapped a pin, read who
     * they could carpool with, and had the favourite star and a close button.
     *
     * Driven through to `requests.create` rather than stopping at presence,
     * because "a Connect button exists" is what the fix would satisfy
     * accidentally if `variant` were threaded to the wrong card in a
     * multi-pin sheet.
     */
    renderPortal();

    await userEvent.click(screen.getByRole("button", { name: "Connect!" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mockCreateRequest).toHaveBeenCalledWith({
      toId: PIN_USER.id,
      message: "",
    });
  });

  it("keeps the schedule and seats the reader is deciding on", () => {
    // `variant="portal"` rather than reusing the detail sheet's selection id,
    // which would have condensed the card and dropped these rows. Stated as a
    // test because the alternative is a one-line change away.
    renderPortal();

    expect(screen.getByText("Seats Available:")).toBeInTheDocument();
    expect(screen.getByText("Job Start:")).toBeInTheDocument();
  });

  it("stays shut for an empty selection, not just a null one", () => {
    // `popupUsers` is `PublicUser[] | null`, so an empty array is reachable
    // and is not the same value as null.
    renderPortal({ otherUsers: [] });

    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });

  it("keeps its own height cap rather than the desktop one", () => {
    /*
     * The two branches stay separate expressions, and SCRUM-483 considered
     * merging them and decided against: this sheet is bottom-anchored against
     * the navigation and the desktop column is top-anchored under desktop
     * chrome, so the two budgets share no term. The desktop token reserves
     * four margins that do not exist here, and applying it to the sheet would
     * make its height a function of chrome it sits nowhere near.
     *
     * The positive half is the assertion that makes the negative one mean
     * something - without it this passes just as well when the element is not
     * found at all.
     */
    renderPortal();

    const sheet = screen.getByText("Riley").closest('[tabindex="0"]');

    expect(sheet).toHaveClass("max-h-[45dvh]");
    expect(sheet).not.toHaveClass("max-h-connect-portal-list");
  });
});

describe("a map pin click at a desktop viewport", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("still opens showing the clicked user", () => {
    // Passes before and after. Desktop was never the broken side, and this is
    // what says the mobile branch did not cost it anything.
    renderPortal();

    expect(screen.getByText("Riley")).toBeInTheDocument();
  });

  it("keeps exactly the two controls it had, in the order it had them", () => {
    // The mobile fix must not reach desktop. `UserCard` already renders the
    // `View Route` + `Connect` row here, so a `Connect!` that ignored the
    // viewport would be a *third* control and a second way to connect, sitting
    // below the row. Read as an ordered list rather than a count, because the
    // criterion is that the tab order does not move.
    //
    // Unfiltered, following `ConnectCard.test.tsx`'s desktop case: a card
    // activation overlay is a `<button>` with no text of its own, so dropping
    // the empty entries would hide the one regression that has no other
    // symptom. The favourite control is a MUI `Rating`, which is radios rather
    // than buttons, so it is absent from this list either way.
    renderPortal();

    // The actions menu (SCRUM-554) is icon-only too, so it is excluded by
    // element, not by its empty text, or an overlay would be excluded with it.
    const menu = screen.getByRole("button", { name: "More actions for Riley" });
    const labels = screen
      .getAllByRole("button")
      .filter((b) => b !== menu)
      .map((b) => b.textContent);

    expect(labels).toEqual(["View Route", "Connect"]);
  });

  it("caps the card list with the token that reserves the chrome above it", () => {
    /*
     * A class-request assertion and deliberately nothing more. The defect
     * SCRUM-483 fixed was arithmetic - the budget reserved 128px for chrome
     * that measures 106.73px, so the list was capped 21px shorter than its own
     * container at every window height - and **none of that is assertable
     * here**. jsdom does no layout and evaluates no `calc()` against a
     * viewport, so the numbers were measured in Chromium against the compiled
     * stylesheet and the geometry belongs in SCRUM-264's Playwright suite.
     *
     * What this catches is the regression that has no other symptom: the cap
     * reverting to a literal. The token's *value* is verified by the four
     * contributors listed at its definition in `tailwind.config.js`; this only
     * says the desktop branch still asks for it.
     */
    renderPortal();

    const list = screen.getByText("Riley").closest('[tabindex="0"]');

    expect(list).toHaveClass("max-h-connect-portal-list");
  });

  it("adds no close button, so the desktop tab order is unchanged", () => {
    // Deliberate rather than an omission. `Dialog` already gives desktop
    // backdrop-click and Escape, and the ticket's criterion is that no desktop
    // behaviour changes - an extra focusable control in the panel would be
    // one. This is also why the branch is `useIsMobile` and not a breakpoint
    // utility: a control hidden by CSS would still be in the tree, and this
    // assertion would pass while the tab order had in fact changed.
    renderPortal();

    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
  });
});
