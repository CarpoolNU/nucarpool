import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { Role, Status } from "@prisma/client";
import { signOut } from "next-auth/react";
import UserSection from "./UserSection";
import { OnboardingFormInputs } from "../../utils/types";
import { UnsavedChangesGuard } from "../../utils/profile/signOutWithGuard";
import {
  MOBILE_WIDTH,
  restoreViewportAfterEach,
  setViewportWidth,
} from "../../testing/viewport";

/**
 * Sign Out, and whether it can still throw away a profile edit.
 *
 * `UserSection` ends in two full-width buttons `gap-5` - 20px - apart: Save
 * Changes, then Sign Out. Sign Out called `signOut()` directly, so a thumb
 * aimed slightly low signed the user out and discarded every pending edit with
 * no prompt and no undo. The profile page has owned an unsaved-changes guard
 * the whole time and handed it to exactly one consumer, `Header`; sign-out was
 * the third exit off the page found to be going around it, after the desktop
 * Map button and the mobile bottom navigation (SCRUM-384).
 *
 * On a phone it is also the *only* route to signing out: `Header` returns the
 * bottom navigation before it reaches `DropDownMenu`, so the desktop
 * dropdown - two deliberate interactions away behind a Headless UI `Menu` -
 * does not exist there.
 *
 * **What these assert is wiring, not geometry.** That the two buttons are 20px
 * apart is a class on their container, and jsdom neither lays out nor resolves
 * Tailwind - see `testing/viewport.ts` for the measured list of what it cannot
 * tell you. The adjacency is the reason this matters and is not the thing
 * under test. What is testable, and what the defect actually was, is which
 * function the button calls.
 */

jest.mock("next-auth/react", () => ({
  signOut: jest.fn(),
}));

/**
 * `ProfilePicture`, rendered in the middle of this section, resolves the
 * current user's avatar through a presigned-URL query. The subject here is the
 * button at the bottom, so the hook is stubbed as a shape rather than driven
 * through a tRPC provider - the same treatment `MessageHeader.test.tsx` gives
 * it.
 */
jest.mock("../../utils/useProfileImage", () => ({
  __esModule: true,
  default: () => ({
    profileImageUrl: null,
    imageLoadError: false,
    isLoading: false,
  }),
}));

const mockSignOut = signOut as jest.MockedFunction<typeof signOut>;

restoreViewportAfterEach();

beforeEach(() => {
  mockSignOut.mockClear();
});

/**
 * A real `useForm`, because `UserSection` takes react-hook-form's `register`,
 * `watch` and `setValue` as props and `registerRoleWithSeatDefault` drives all
 * three. Mocking that shape would assert against the mock.
 *
 * `role` is `RIDER`: a `VIEWER` renders the text fields disabled, which has
 * nothing to do with the buttons but makes the tree harder to read.
 */
const Harness = ({
  checkChanges,
  onSubmit,
}: {
  checkChanges: UnsavedChangesGuard;
  onSubmit?: () => void;
}) => {
  const { register, watch, setValue, handleSubmit, formState } =
    useForm<OnboardingFormInputs>({
      defaultValues: {
        role: Role.RIDER,
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
      onSubmit={handleSubmit(() => onSubmit?.())}
      onFileSelect={() => undefined}
      checkChanges={checkChanges}
    />
  );
};

const signOutButton = () => screen.getByRole("button", { name: "Sign Out" });

describe("Sign Out and the unsaved-changes guard", () => {
  it("asks the guard instead of signing out on the spot", async () => {
    // A guard that answers nothing is the unsaved case: the page has raised
    // `UnsavedModal` and is waiting on the user. Nothing may have happened yet.
    const checkChanges = jest.fn();
    render(<Harness checkChanges={checkChanges} />);

    await userEvent.click(signOutButton());

    expect(checkChanges).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("signs out once the guard releases the callback", async () => {
    // The nothing-to-lose path, and the Continue and Save answers to the
    // modal: all three end in the guard running what it was handed.
    const checkChanges = jest.fn((proceed: () => void | Promise<void>) =>
      proceed(),
    );
    render(<Harness checkChanges={checkChanges} />);

    await userEvent.click(signOutButton());

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("holds the sign-out until the guard is answered, then performs it", async () => {
    // The modal, in two steps. The callback is captured rather than called,
    // the way `checkForChanges` parks it in `proceedRef`, and released only
    // when the user chooses. A guard consulted but not awaited would pass the
    // first assertion below and fail the second.
    let release: (() => void | Promise<void>) | null = null;
    const checkChanges = jest.fn((proceed: () => void | Promise<void>) => {
      release = proceed;
    });
    render(<Harness checkChanges={checkChanges} />);

    await userEvent.click(signOutButton());
    expect(mockSignOut).not.toHaveBeenCalled();

    await act(async () => {
      await release?.();
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("leaves the user signed in when the guard is never answered", async () => {
    // Cancel. `checkForChanges` drops the pending callback, so it is simply
    // never run - and a second press has to go through the guard again rather
    // than finding a signed-out route left open.
    const checkChanges = jest.fn();
    render(<Harness checkChanges={checkChanges} />);

    await userEvent.click(signOutButton());
    await userEvent.click(signOutButton());

    expect(checkChanges).toHaveBeenCalledTimes(2);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("is present on mobile, where it is the only way to sign out", () => {
    // `Header` returns the bottom navigation before reaching `DropDownMenu`,
    // so this button carries the whole of sign-out on a phone. If that ever
    // stops being true the premise of the fix changes, so assert it rather
    // than assume it.
    setViewportWidth(MOBILE_WIDTH);
    render(<Harness checkChanges={jest.fn()} />);

    const button = signOutButton();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });
});

describe("the role radios (SCRUM-521)", () => {
  // `Radio` already destructured `role` out of its props before spreading
  // the rest onto the native input, so this call site was never affected by
  // the sibling bug in `FormRadioButton` - the dead `role={Role.X}` prop
  // passed here has been removed as the same cleanup, and this guards
  // against either component starting to forward it.
  it("are reachable as radios, not as their Role enum value", () => {
    render(<Harness checkChanges={jest.fn()} />);

    expect(screen.getByRole("radio", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Rider" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Driver" })).toBeInTheDocument();
  });

  it("carry no explicit role attribute, leaving the browser's implicit one", () => {
    render(<Harness checkChanges={jest.fn()} />);

    for (const name of ["Viewer", "Rider", "Driver"]) {
      const input = screen.getByLabelText(name, { selector: "input" });
      expect(input).not.toHaveAttribute("role");
    }
  });
});

describe("Save Changes, the button Sign Out sits under", () => {
  it("still submits, and does not go through the guard", async () => {
    // The guard belongs to leaving the page. Saving stays on it, so routing
    // sign-out through the guard must not have caught the primary action too.
    const checkChanges = jest.fn();
    const onSubmit = jest.fn();
    render(<Harness checkChanges={checkChanges} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(checkChanges).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("comes before Sign Out, which is why the mis-tap goes the way it does", () => {
    // Tree order is observable in jsdom; the 20px between them is not. This
    // holds the arrangement the fix was written against: Sign Out is the
    // button *below* the one the user wants.
    render(<Harness checkChanges={jest.fn()} />);

    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);

    expect(names.slice(-2)).toEqual(["Save Changes", "Sign Out"]);
  });
});
