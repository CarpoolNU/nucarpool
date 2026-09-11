import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role } from "@prisma/client";
import { GroupPage } from "./GroupPage";
import { UserContext } from "../../utils/userContext";
import { User } from "../../utils/types";
import {
  DESKTOP_WIDTH,
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";
import { DEFAULT_GROUP_DETAILS } from "./groupDetails";

/**
 * Dismissing "My Group" on mobile.
 *
 * The desktop branch renders inside Headless UI's `Dialog`, so it has dismissed
 * on backdrop click and on Escape since it was written. The mobile branch is a
 * bare `fixed inset-0` div whose header held the title and nothing else, and it
 * dropped `onClose` at the top level entirely - so the only way out of My Group
 * on a phone was tapping a different navigation tab. There was no Escape
 * handling either.
 *
 * Why the mobile branch does not simply adopt `Dialog`, since that would supply
 * both behaviours for free: `Dialog` also installs a focus trap, and the bottom
 * navigation is `z-index: 100` against this screen's `z-50`. The tab bar stays
 * visible and tappable on top of this view, so a trap would let a pointer reach
 * navigation the keyboard could not - worse than no trap. This is a full-screen
 * view with live navigation over it rather than a modal, so it gets the one
 * dismissal behaviour it lacked, not the whole modal contract. These tests pin
 * that decision: they assert the control and the key, and deliberately do not
 * assert a focus trap.
 *
 * `trpc` and `useGroupDetails` are mocked as shapes rather than driven through
 * a real client and provider, following `useGroupDetails.test.tsx` - the
 * subject here is the header's dismissal wiring, and a real QueryClient would
 * be testing @tanstack/react-query instead. The mocks are configured inside the
 * `jest.mock` factories only with values that need no module-scope `const`,
 * for the temporal-dead-zone reason that file documents.
 */

jest.mock("../../utils/trpc", () => ({
  trpc: {
    user: {
      me: { useQuery: () => ({ data: undefined }) },
      groups: { me: { useQuery: () => ({ data: undefined }) } },
    },
  },
}));

jest.mock("./useGroupDetails", () => ({
  useGroupDetails: () => ({
    details: {
      musicPreference: "",
      snackPreference: "",
      conversationStyle: "",
      groupNotes: "",
    },
    setDetails: jest.fn(),
    save: jest.fn(),
    isSaving: false,
  }),
}));

restoreViewportAfterEach();

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

const renderGroupPage = (onClose: () => void) =>
  render(
    <UserContext.Provider value={USER_WITHOUT_GROUP}>
      <GroupPage onClose={onClose} onViewGroupRoute={() => undefined} />
    </UserContext.Provider>,
  );

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
   * Counting `addEventListener` calls was tried first and rejected: other
   * things in the tree register `keydown` on `window`, so `added > 0` holds
   * even with this feature absent, and the test passed against the unfixed
   * component.
   */
  it("stops listening once unmounted", async () => {
    const onClose = jest.fn();
    const { unmount } = renderGroupPage(onClose);

    unmount();
    await userEvent.keyboard("{Escape}");

    expect(onClose).not.toHaveBeenCalled();
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
