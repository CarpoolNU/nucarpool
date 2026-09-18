/**
 * "My Group" for a carpool group that has no driver.
 *
 * `GroupMembers` resolved the driver before deciding whether to render at all
 * and shared one early return with the genuine loading state:
 *
 *     if (!driver || !curUser) return <Spinner />;
 *
 * For a group whose members include no `DRIVER` that branch never ends. The
 * query has already succeeded, there is no driver, and no amount of waiting
 * produces one - so both the mobile screen and the desktop modal showed a
 * spinner where the member list belongs, with no message and no way out. 15
 * groups holding 33 members were in that state on production.
 *
 * The exit itself was never missing. `groups.edit` skips the seat credit rather
 * than failing it for exactly this case, commented "leaving one at a time is
 * the only way its riders can get out", and `groups.test.ts` pins it. The
 * button that reaches it was what did not exist. SCRUM-457.
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
    },
  },
}));

jest.mock("./useGroupDetails", () => ({
  useGroupDetails: jest.fn(),
}));

jest.mock("react-toastify/unstyled", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const mockedTrpc = trpc as unknown as {
  useUtils: jest.Mock;
  user: {
    me: { useQuery: jest.Mock };
    groups: {
      me: { useQuery: jest.Mock };
      edit: { useMutation: jest.Mock };
      delete: { useMutation: jest.Mock };
    };
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
 * These carried `hidden: true` when this file was written, and no longer do.
 *
 * The desktop branch used to wrap its whole `Dialog.Panel` in a `div` marked
 * `aria-hidden="true"`, so every control inside it - including the one this
 * file's ticket added - was absent from the accessibility tree that `getByRole`
 * resolves against. `hidden: true` made a role query ignore that exclusion, so
 * these addressed the button that existed rather than the one the modal
 * announced. The wrapper was the defect, filed as SCRUM-475 and deliberately
 * not fixed here; SCRUM-475 has since split the backdrop out into a sibling,
 * and the flag came off with it.
 *
 * It mattered just as much on the **negative** assertions, which is the part
 * worth not losing. While everything in that panel was hidden,
 * `queryByRole("button", { name: "Remove" })` on desktop returned null whether
 * or not a Remove button was drawn - so "Remove is not offered" held for the
 * wrong reason and would have kept holding through a regression. Now that the
 * panel is in the tree, the query means what it says on both branches, without
 * the flag papering over the difference.
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
   * The point of the ticket. Reaching the mutation is what "working" means
   * here: a button that renders and then calls nothing would satisfy the
   * assertion above and leave the 33 members exactly as stuck.
   *
   * `groupId` is the caller's own `carpoolId`, which is the change that let the
   * hook run at all - it used to read the group off `driver.carpoolId`, and
   * there is no driver row to read. `driverId` is the caller's own id because
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
   * nothing ties the two together, so `VIEWER` members are real. The badge was
   * a two-way conditional on `=== DRIVER`, which put every one of them in the
   * "Rider" half.
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
