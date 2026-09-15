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

/**
 * The keys are `GroupDetails`', spelled out rather than spread from
 * `DEFAULT_GROUP_DETAILS` - a `jest.mock` factory runs while the module under
 * test is being required, before the imports above are initialised, so it can
 * only use literals. `groupDetails.ts` is the source of truth for the shape.
 *
 * They were `musicPreference`, `snackPreference`, `conversationStyle` and
 * `groupNotes` until SCRUM-475, and the last three of those are not fields.
 * Nothing noticed, because the only body these tests rendered was a RIDER's,
 * which is prose - `GroupDetailsForm` reads `details.notes` and appears on the
 * DRIVER branch alone, which nothing here reached until the desktop
 * accessibility cases below.
 */
jest.mock("./useGroupDetails", () => ({
  useGroupDetails: () => ({
    details: {
      notes: "",
      musicPreference: "",
      conversationStyle: "",
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

  /**
   * **A proxy, not a measurement.** What actually matters is that the sticky
   * action bar holding "Preview Group Route" is not behind the bottom
   * navigation, and jsdom cannot check that: it computes no geometry, no
   * `z-index` and no `env()` - see `src/testing/viewport.ts`. This asserts the
   * class that encodes the clearance and nothing more, so it catches the
   * regression of someone putting `inset-0` back and catches nothing else.
   *
   * The real assertion belongs in SCRUM-264's Playwright suite:
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
 * The backdrop used to wrap the `Dialog.Panel` rather than sit beside it, and
 * it carries `aria-hidden="true"`. That attribute applies to the entire subtree
 * and no descendant can opt back in, so every control the modal offers - the
 * group-details form and its Submit, "Preview Group Route", "Leave Group",
 * "Remove", "Delete Group" - was absent from the accessibility tree while
 * rendering, staying visible, and staying clickable with a mouse. SCRUM-475.
 *
 * `getByRole` resolves against that tree and `getByText` does not, which is the
 * only reason these assertions can tell the difference. It is also why the
 * queries below deliberately carry no `{ hidden: true }` - the flag
 * `GroupPage.driverless.test.tsx` needed to work around this, and has now
 * dropped.
 *
 * Note what the `does not render the mobile close control` case above could not
 * prove while the defect stood: with the whole panel hidden, *every*
 * `queryByRole` in this branch returned null, so that negative held whether or
 * not the button was drawn. It passed for the wrong reason. It only becomes an
 * assertion about the close control once the panel is in the tree.
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

  const renderDesktopModal = () =>
    render(
      <UserContext.Provider value={DRIVING_USER_WITHOUT_GROUP}>
        <GroupPage
          onClose={() => undefined}
          onViewGroupRoute={() => undefined}
        />
      </UserContext.Provider>,
    );

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
