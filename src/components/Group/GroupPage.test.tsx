/**
 * `GroupPage`: a group with no driver, and how My Group is dismissed and
 * announced.
 *
 * `trpc` and `useGroupDetails` are mocked with `jest.fn()`s configured in
 * `beforeEach`, because the driverless cases vary `groups.me` per test; each
 * render helper states the `groups.me` result it wants, which makes that
 * result visible at the point of use.
 *
 * `useGroupDetails` returns `DEFAULT_GROUP_DETAILS` for every block - the
 * real constant rather than a hand-written literal - so a block's mock
 * cannot drift from the real shape of `GroupDetails`.
 *
 * ---
 *
 * "My Group" for a carpool group that has no driver.
 *
 * A component must not resolve the driver before deciding whether to render
 * at all, sharing one early return with the genuine loading state:
 *
 *     if (!driver || !curUser) return <Spinner />;
 *
 * For a group whose members include no `DRIVER` that branch would never end.
 * The query has already succeeded, there is no driver, and no amount of
 * waiting produces one - so both the mobile screen and the desktop modal
 * would show a spinner where the member list belongs, with no message and
 * no way out. 15 groups holding 33 members were found in that state on
 * production.
 *
 * The exit itself is not missing: `groups.edit` skips the seat credit rather
 * than failing it for exactly this case, commented "leaving one at a time is
 * the only way its riders can get out", and `groups.test.ts` pins it. What
 * this file pins is that a button reaching it actually exists.
 *
 * ---
 *
 * **Why these go through `GroupPage` rather than rendering `GroupMembers`
 * alone.** The acceptance criterion is "on both the mobile and the desktop
 * branch", and `GroupMembers` has no branch of its own - it renders the same
 * tree at every width. The two branches are `MobileGroupView` and
 * `DesktopGroupView`, which is one level up, so that is the level these render
 * at. The last `describe` is the exception: the surviving loading state is
 * `GroupMembers`' own, and `GroupPage` returns its own spinner before reaching
 * it, so that one addresses the component directly.
 *
 * `trpc` and `useGroupDetails` are mocked as shapes rather than driven through
 * a real client and provider, following `useGroupDetails.test.tsx` - and, as
 * that file documents, they are configured in `beforeEach` rather than inside
 * the `jest.mock` factories, because a factory runs while the module under test
 * is being required, before any `const` here is initialised.
 *
 * jsdom does no layout, so nothing here is a claim about what the screen looks
 * like; these assert reachability and wiring. See `src/testing/viewport.ts`.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role } from "@prisma/client";
import { trpc } from "../../utils/trpc";
import { GroupPage } from "./GroupPage";
import { GroupMembers } from "./GroupMemberCard";
import { useGroupDetails } from "./useGroupDetails";
import { DEFAULT_GROUP_DETAILS } from "./groupDetails";
import { UserContext } from "../../utils/userContext";
import { PublicUser, User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

jest.mock("../../utils/trpc", () => ({
  trpc: {
    useUtils: jest.fn(),
    user: {
      me: { useQuery: jest.fn() },
      groups: {
        me: { useQuery: jest.fn() },
        edit: { useMutation: jest.fn() },
        delete: { useMutation: jest.fn() },
      },
      // `UserActionsMenu` on the member rows. Its block confirmation mounts
      // with the row rather than on open - the dialog has no form to reset -
      // so this hook runs even though nothing in this file opens the menu.
      blocks: { block: { useMutation: jest.fn() } },
    },
  },
}));

jest.mock("./useGroupDetails", () => ({
  useGroupDetails: jest.fn(),
}));

jest.mock("react-toastify/unstyled", () =>
  require("../../testing/toastStub").buildToastMock(),
);

/*
 * The member rows draw a `ProfileAvatar`, which resolves a presigned URL
 * through `trpc.user.getPresignedDownloadUrl` - a procedure this file's trpc
 * stub does not carry and has no reason to. The default result is no picture,
 * settled, so every row takes the fallback branch and nothing here waits on a
 * query it does not care about.
 */
jest.mock("../../utils/useProfileImage", () =>
  require("../../testing/profileImageStub").buildProfileImageMock(),
);

const mockedTrpc = trpc as unknown as {
  useUtils: jest.Mock;
  user: {
    me: { useQuery: jest.Mock };
    groups: {
      me: { useQuery: jest.Mock };
      edit: { useMutation: jest.Mock };
      delete: { useMutation: jest.Mock };
    };
    blocks: { block: { useMutation: jest.Mock } };
  };
};

const mockedUseGroupDetails = useGroupDetails as unknown as jest.Mock;

restoreViewportAfterEach();

const GROUP_ID = "group-driverless";

/**
 * A member row as `groups.me` returns one. Cast rather than filled in: the
 * member card reads `id`, `preferredName`, `email` and `role`, and `carpoolId`
 * is what `useGroupMembership` now takes the group from.
 */
const member = (id: string, preferredName: string, role: Role): PublicUser =>
  ({
    id,
    preferredName,
    role,
    email: `${id}@northeastern.edu`,
    carpoolId: GROUP_ID,
  }) as unknown as PublicUser;

/** The caller. A `RIDER`, so nothing here may manage the group. */
const SAM = member("sam", "Sam", Role.RIDER);

/**
 * `VIEWER`, not `RIDER`. 8 of the 33 stranded members on production are viewer
 * rows, and the badge labelled every one of them "Rider" - so this fixture is
 * the common case rather than an edge one.
 */
const ALEX = member("alex", "Alex", Role.VIEWER);

/** A third member, for the group that leaving does *not* dissolve. */
const JO = member("jo", "Jo", Role.RIDER);

const CUR_USER = SAM as unknown as User;

/**
 * What the server sends for one of these groups: members, and `hasDriver`
 * false. Not a driver among them - that is the whole state.
 */
const driverlessGroup = (users: PublicUser[]) => ({
  id: GROUP_ID,
  hasDriver: false,
  preferences: {
    groupNotes: null,
    groupMusicPreference: null,
    groupConversationStyle: null,
  },
  users,
});

const editGroup = jest.fn();
const deleteGroup = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();

  mockedTrpc.useUtils.mockReturnValue({
    user: {
      me: { invalidate: jest.fn() },
      groups: { me: { invalidate: jest.fn() } },
    },
  });
  mockedTrpc.user.me.useQuery.mockReturnValue({ data: undefined });
  mockedTrpc.user.groups.edit.useMutation.mockReturnValue({
    mutate: editGroup,
    isPending: false,
  });
  mockedTrpc.user.groups.delete.useMutation.mockReturnValue({
    mutate: deleteGroup,
    isPending: false,
  });
  // Inert. This file is about which actions each group state offers, not
  // about performing one, and `jest.clearAllMocks()` above would otherwise
  // leave this returning `undefined` to a destructuring call site.
  mockedTrpc.user.blocks.block.useMutation.mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
  });

  // The real default rather than a hand-written literal: `GroupDetailsPreview`
  // pushes this straight into `normalizeDetails`, which reads every key.
  mockedUseGroupDetails.mockReturnValue({
    details: DEFAULT_GROUP_DETAILS,
    setDetails: jest.fn(),
    save: jest.fn(),
    isSaving: false,
  });
});

/**
 * These do not carry `hidden: true`.
 *
 * If the desktop branch wrapped its whole `Dialog.Panel` in a `div` marked
 * `aria-hidden="true"`, every control inside it would be absent from the
 * accessibility tree that `getByRole` resolves against, and `hidden: true`
 * would be needed to make a role query ignore that exclusion - addressing
 * the button that exists rather than the one the modal announces. See the
 * accessibility-tree block at the end of this file for why the backdrop is a
 * sibling of the panel rather than its wrapper.
 *
 * That would matter just as much on the **negative** assertions, which is
 * the part worth not losing. With everything in that panel hidden,
 * `queryByRole("button", { name: "Remove" })` on desktop would return null
 * whether or not a Remove button was drawn - so "Remove is not offered"
 * would hold for the wrong reason and would keep holding through a
 * regression. With the panel in the tree, the query means what it says on
 * both branches, without a flag papering over the difference.
 */
const button = (name: string) => screen.getByRole("button", { name });

const maybeButton = (name: string) => screen.queryByRole("button", { name });

const renderDriverlessGroup = (users: PublicUser[] = [SAM, ALEX]) => {
  mockedTrpc.user.groups.me.useQuery.mockReturnValue({
    data: driverlessGroup(users),
    isLoading: false,
    isError: false,
  });

  return render(
    <UserContext.Provider value={CUR_USER}>
      <GroupPage onClose={() => undefined} onViewGroupRoute={() => undefined} />
    </UserContext.Provider>,
  );
};

/**
 * A RIDER with no `carpoolId`, which routes to `NoGroupSection` - the lightest
 * of the two bodies. Which body renders is irrelevant to the header under test,
 * and this one needs no group fixture.
 */
const USER_WITHOUT_GROUP = {
  id: "user-1",
  role: Role.RIDER,
  carpoolId: null,
  preferredName: "Sam",
  ...DEFAULT_GROUP_DETAILS,
} as unknown as User;

/**
 * The no-group render the dismissal cases below use. `groups.me` is stated here
 * rather than in the `jest.mock` factory, the same way `renderDriverlessGroup`
 * states its own - so what each block asks the server for is readable from the
 * block.
 */
const renderGroupPage = (onClose: () => void) => {
  mockedTrpc.user.groups.me.useQuery.mockReturnValue({ data: undefined });

  return render(
    <UserContext.Provider value={USER_WITHOUT_GROUP}>
      <GroupPage onClose={onClose} onViewGroupRoute={() => undefined} />
    </UserContext.Provider>,
  );
};

describe.each([
  ["mobile", MOBILE_WIDTH],
  ["desktop", DESKTOP_WIDTH],
])("a group with no driver, on %s", (_variant, width) => {
  beforeEach(() => {
    setViewportWidth(width);
  });

  it("renders its members instead of a spinner", () => {
    renderDriverlessGroup();

    expect(screen.getByText("Sam")).toBeInTheDocument();
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("offers the caller a way out", () => {
    renderDriverlessGroup();

    expect(button("Leave Group")).toBeInTheDocument();
  });

  /**
   * Reaching the mutation is what "working" means
   * here: a button that renders and then calls nothing would satisfy the
   * assertion above and leave the 33 members exactly as stuck.
   *
   * `groupId` is the caller's own `carpoolId`, which is what lets the hook
   * run at all for a driverless group: there is no driver row to read a
   * group off `driver.carpoolId`. `driverId` is the caller's own id because
   * `groups.edit` requires the field and ignores it on the remove path,
   * resolving the driver from the group's membership itself.
   */
  it("leaves the group when that way out is taken", async () => {
    renderDriverlessGroup();

    await userEvent.click(button("Leave Group"));
    await userEvent.click(button("Confirm"));

    expect(editGroup).toHaveBeenCalledTimes(1);
    expect(editGroup).toHaveBeenCalledWith({
      driverId: "sam",
      riderId: "sam",
      add: false,
      groupId: GROUP_ID,
    });
  });

  /**
   * Report and Block, on the screen where the counterpart is somebody the
   * reader is actually sharing a car with. `UserActionsMenu` reaches the user
   * cards and the conversation header; without it here too, this would be
   * the one relationship in the app whose moderation controls are a
   * navigation away.
   *
   * Through `GroupPage` rather than the card, deliberately: `GroupMemberCard`
   * takes `showUserActions` as a prop and defaults it off, so the card's own
   * suite can only show that the menu *can* be drawn. Whether it is reachable
   * in the product depends on this list passing the prop, which is what this
   * asserts. It is also where the self-row exclusion is worth re-checking,
   * because the list passes the prop to the caller's row too.
   */
  it("offers report and block on the other members, and not on the reader", () => {
    renderDriverlessGroup([SAM, ALEX, JO]);

    expect(button("More actions for Alex")).toBeInTheDocument();
    expect(button("More actions for Jo")).toBeInTheDocument();
    // The caller. `applyBlock` refuses a self-block outright.
    expect(maybeButton("More actions for Sam")).not.toBeInTheDocument();
  });

  /**
   * `requireGroupDriver` refuses every management action for every caller in
   * this state, so offering one would be offering a rejection.
   */
  it("offers no action the server would refuse", () => {
    renderDriverlessGroup();

    expect(maybeButton("Delete Group")).not.toBeInTheDocument();
    expect(maybeButton("Remove")).not.toBeInTheDocument();
  });

  it("says why there is nothing to manage", () => {
    renderDriverlessGroup();

    expect(screen.getByText("This group has no driver")).toBeInTheDocument();
  });

  /**
   * `groups.edit` dissolves a group once one member would be left, and 14 of
   * the 15 driverless groups on production hold exactly two members - so for
   * almost all of them this is what leaving does, and it is said before the
   * confirmation rather than reported in a toast afterwards.
   */
  it("warns that leaving a pair dissolves the group", () => {
    renderDriverlessGroup([SAM, ALEX]);

    expect(screen.getByText(/dissolve the group/i)).toBeInTheDocument();
  });

  it("does not warn of that when a third member would remain", () => {
    renderDriverlessGroup([SAM, ALEX, JO]);

    expect(screen.queryByText(/dissolve/i)).not.toBeInTheDocument();
  });

  /**
   * A group member's role lives on `CarpoolSearch` beside `carpoolId` and
   * nothing ties the two together, so `VIEWER` members are real. A two-way
   * conditional on `=== DRIVER` would put every one of them in the "Rider"
   * half.
   */
  it("labels a viewer as a viewer", () => {
    renderDriverlessGroup();

    expect(screen.getByText("Viewer")).toBeInTheDocument();
    expect(screen.getByText("Rider")).toBeInTheDocument();
  });
});

/**
 * The state that *should* keep the spinner, which is the risk in splitting the
 * condition: `UserContext` is null until `user.me` resolves, and no row can be
 * drawn without the caller - not even the caller's own.
 *
 * Rendered against `GroupMembers` directly because `GroupPage` returns its own
 * spinner for a null `curUser` several levels above this one, so going through
 * the page would assert the wrong component's loading state and pass with this
 * branch deleted.
 */
describe("the member list before the current user has loaded", () => {
  it("still shows a spinner", () => {
    render(
      <UserContext.Provider value={null}>
        <GroupMembers users={[SAM, ALEX]} />
      </UserContext.Provider>,
    );

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.queryByText("Sam")).not.toBeInTheDocument();
  });
});

/**
 * Dismissing "My Group" on mobile.
 *
 * The desktop branch renders inside Headless UI's `Dialog`, so it dismisses
 * on backdrop click and on Escape. The mobile branch is a bare `fixed
 * inset-0` div with neither built in: without a Close button in its header
 * and the Escape handling wired below, the only way out of My Group on a
 * phone would be tapping a different navigation tab.
 *
 * Why the mobile branch does not simply adopt `Dialog`, since that would supply
 * both behaviours for free: `Dialog` also installs a focus trap, and the bottom
 * navigation is `z-index: 100` against this screen's `z-50`. The tab bar stays
 * visible and tappable on top of this view, so a trap would let a pointer reach
 * navigation the keyboard could not - worse than no trap. This is a full-screen
 * view with live navigation over it rather than a modal, so it gets only the
 * one dismissal behaviour that matters here (Escape), not the whole modal
 * contract. These tests pin that decision: they assert the control and the
 * key, and deliberately do not assert a focus trap.
 *
 * `trpc` and `useGroupDetails` are mocked as shapes rather than driven through
 * a real client and provider, following `useGroupDetails.test.tsx` - the
 * subject here is the header's dismissal wiring, and a real QueryClient would
 * be testing @tanstack/react-query instead.
 */
describe("My Group on mobile", () => {
  beforeEach(() => {
    setViewportWidth(MOBILE_WIDTH);
  });

  it("offers a close control", () => {
    renderGroupPage(() => undefined);

    expect(
      screen.getByRole("button", { name: "Close My Group" }),
    ).toBeInTheDocument();
  });

  it("closes when that control is pressed", async () => {
    const onClose = jest.fn();
    renderGroupPage(onClose);

    await userEvent.click(
      screen.getByRole("button", { name: "Close My Group" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    const onClose = jest.fn();
    renderGroupPage(onClose);

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores keys that are not Escape", async () => {
    const onClose = jest.fn();
    renderGroupPage(onClose);

    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("a");

    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * The listener goes on `window`, so it outlives the component unless the
   * effect cleans up.
   *
   * Dispatching after unmount is a real assertion *here*, unlike in
   * `useIsMobile.test.tsx` where the same shape proves nothing. The difference
   * is the observable: that hook's handler only calls `setState`, which React
   * discards silently once unmounted, so a version with no cleanup passes. This
   * handler calls `onClose`, which reaches a prop — a plain `jest.fn` that
   * records the call whether or not React is still mounted. Delete the cleanup
   * and this fails.
   *
   * Counting `addEventListener` calls would not work: other things in the
   * tree register `keydown` on `window`, so `added > 0` would hold even with
   * this feature absent, passing regardless of whether it exists.
   */
  it("stops listening once unmounted", async () => {
    const onClose = jest.fn();
    const { unmount } = renderGroupPage(onClose);

    unmount();
    await userEvent.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * **A proxy, not a measurement.** What actually matters is that the sticky
   * action bar holding "Preview Group Route" is not behind the bottom
   * navigation, and jsdom cannot check that: it computes no geometry, no
   * `z-index` and no `env()` - see `src/testing/viewport.ts`. This asserts the
   * class that encodes the clearance and nothing more, so it catches the
   * regression of someone putting `inset-0` back and catches nothing else.
   *
   * The real assertion belongs in the project's Playwright suite:
   * `boundingBox().y + height <= viewportHeight - navHeight` for this overlay.
   *
   * `inset-0` is asserted absent as well as `bottom-mobile-nav` present,
   * because the two together are contradictory rather than additive - Tailwind
   * emits both `bottom: 0` and the token, and which one wins is source order
   * in the compiled stylesheet, not the class list. A version carrying both
   * would pass a presence-only check while still overlapping.
   */
  it("reserves the bottom navigation's height on the overlay root", () => {
    const { container } = renderGroupPage(() => undefined);

    const overlay = container.firstElementChild;

    expect(overlay).toHaveClass("fixed", "bottom-mobile-nav", "inset-x-0");
    expect(overlay).not.toHaveClass("inset-0");
  });
});

describe("My Group on desktop", () => {
  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  /**
   * The mobile close control must not leak into the desktop tree, which has its
   * own dismissal through `Dialog` and a differently styled header.
   */
  it("does not render the mobile close control", () => {
    renderGroupPage(() => undefined);

    expect(
      screen.queryByRole("button", { name: "Close My Group" }),
    ).not.toBeInTheDocument();
  });

  /**
   * Escape is `Dialog`'s job on desktop, not the hand-rolled listener's. This
   * pins that the effect stays inert above the breakpoint — if it ran on both,
   * `onClose` would fire twice per Escape on desktop.
   */
  it("closes on Escape exactly once", async () => {
    const onClose = jest.fn();
    renderGroupPage(onClose);

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Whether the desktop modal exists for assistive technology at all.
 *
 * The backdrop sits beside the `Dialog.Panel` rather than wrapping it. If it
 * wrapped the panel instead, its `aria-hidden="true"` would apply to the
 * entire subtree with no way for a descendant to opt back in, so every
 * control the modal offers - the group-details form and its Submit,
 * "Preview Group Route", "Leave Group", "Remove", "Delete Group" - would be
 * absent from the accessibility tree while still rendering, staying visible,
 * and staying clickable with a mouse.
 *
 * `getByRole` resolves against that tree and `getByText` does not, which is
 * the only reason these assertions can tell the difference. It is also why
 * the queries below deliberately carry no `{ hidden: true }` - the flag the
 * driverless block above would need to work around a wrapping backdrop.
 *
 * Note what the `does not render the mobile close control` case above could
 * not prove if the backdrop wrapped the panel: with the whole panel hidden,
 * *every* `queryByRole` in this branch would return null, so that negative
 * would hold whether or not the button was drawn - passing for the wrong
 * reason. It only becomes an assertion about the close control with the
 * panel in the tree.
 */
describe("My Group's desktop modal in the accessibility tree", () => {
  /**
   * A DRIVER rather than the RIDER the cases above use, because the desktop
   * no-group body only draws a control - Submit, under the group-details form -
   * for a driver. A rider's is prose, which has no role to query.
   */
  const DRIVING_USER_WITHOUT_GROUP = {
    ...USER_WITHOUT_GROUP,
    role: Role.DRIVER,
  } as unknown as User;

  const renderDesktopModal = () => {
    mockedTrpc.user.groups.me.useQuery.mockReturnValue({ data: undefined });

    return render(
      <UserContext.Provider value={DRIVING_USER_WITHOUT_GROUP}>
        <GroupPage
          onClose={() => undefined}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>,
    );
  };

  beforeEach(() => {
    setViewportWidth(DESKTOP_WIDTH);
  });

  it("offers the panel's controls as controls", () => {
    renderDesktopModal();

    expect(screen.getByRole("button", { name: "Submit" })).toBeInTheDocument();
  });

  it("announces the dialog's title", () => {
    renderDesktopModal();

    expect(
      screen.getByRole("heading", { name: "My Group" }),
    ).toBeInTheDocument();
  });

  it("puts no aria-hidden on any ancestor of the panel", () => {
    renderDesktopModal();

    const hiddenAncestors: string[] = [];

    for (
      let node = screen.getByRole("button", { name: "Submit" })
        .parentElement as HTMLElement | null;
      node && node !== document.body;
      node = node.parentElement
    ) {
      if (node.getAttribute("aria-hidden") === "true") {
        hiddenAncestors.push(node.className);
      }
    }

    expect(hiddenAncestors).toEqual([]);
  });

  /**
   * The other half of the pin. Deleting `aria-hidden` outright would satisfy
   * every assertion above, and would put a decorative blur layer into the
   * accessibility tree instead - so the backdrop is asserted from its own side.
   *
   * Selected by the class that draws the blur rather than by the attribute:
   * Headless UI marks internal nodes of its own `aria-hidden`, so the attribute
   * does not identify this element on its own.
   */
  it("keeps the backdrop hidden, and still blurring", () => {
    const { baseElement } = renderDesktopModal();

    const backdrops = baseElement.querySelectorAll(".backdrop-blur-xs");

    expect(backdrops).toHaveLength(1);
    expect(backdrops[0]).toHaveAttribute("aria-hidden", "true");
    expect(backdrops[0]).not.toContainElement(
      screen.getByRole("button", { name: "Submit" }),
    );
  });
});
