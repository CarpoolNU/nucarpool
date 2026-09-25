import { signOut } from "next-auth/react";
import { resetIdentity } from "../mixpanel";

/**
 * Leave, and stop being this user as far as Mixpanel is concerned.
 *
 * The reset runs *before* `signOut`, which navigates: anything queued behind
 * that call may never run. It is also deliberately here rather than beside
 * either button - `DropDownMenu` and `UserSection` both reach sign-out through
 * this module, and the set of exits from the profile page is precisely the
 * thing that was discovered one at a time across SCRUM-384 and SCRUM-468.
 *
 * Only reached once the guard below has let the sign-out through, so cancelling
 * `UnsavedModal` leaves the identity intact along with the unsaved edits.
 */
const signOutAndForget = async (): Promise<void> => {
  resetIdentity();
  await signOut();
};

/**
 * The profile page's unsaved-changes guard, as the things that consume it see
 * it.
 *
 * There is one implementation: `checkForChanges` in
 * `src/pages/profile/index.tsx`, which compares the live form against the
 * stored user through `hasProfileChanges` and either runs `proceed`
 * immediately or holds it behind `UnsavedModal`. Taking the caller's exit as a
 * callback rather than a destination is SCRUM-384's shape, and the reason is
 * written down there: it keeps each consumer's own way of leaving - a router
 * push, a full page load, a sign-out - in the consumer.
 *
 * Named here rather than written inline in `HeaderProps` so the set of things
 * that accept the guard is one identifier away from a grep. That the set was
 * not writable down anywhere is how three separate exits from the page came to
 * be discovered one at a time: the desktop Map button, then the mobile bottom
 * navigation (SCRUM-384), then Sign Out (SCRUM-468).
 */
export type UnsavedChangesGuard = (
  proceed: () => void | Promise<void>,
) => void | Promise<void>;

/**
 * Sign out, offering to save first when the caller sits somewhere with unsaved
 * work to lose.
 *
 * Signing out leaves the profile page like any other navigation, and it was
 * the exit nobody enumerated. `UserSection` renders it as a full-width button
 * `gap-5` - 20px - directly under Save Changes, and on a phone it is the
 * *only* route to signing out at all, because `Header` returns the bottom
 * navigation before it ever reaches `DropDownMenu`. So the likeliest press of
 * the most destructive control on the page was a thumb aimed 20px higher, and
 * it discarded every pending edit with no prompt and no undo.
 *
 * `checkChanges` is optional because most of the app has nothing to lose:
 * `DropDownMenu` is mounted on every signed-in page and only the profile page
 * supplies a guard. Without one this is the bare sign-out both call sites used
 * to make, which is why adding the guard to one of them could not change
 * behaviour anywhere else.
 */
export const signOutWithGuard = async (
  checkChanges?: UnsavedChangesGuard,
): Promise<void> => {
  if (!checkChanges) {
    await signOutAndForget();
    return;
  }

  // The guard decides, and all three of its answers are the ones a
  // confirmation needs: with nothing unsaved it runs this straight away, with
  // something unsaved it holds it until the user answers `UnsavedModal`, and
  // if they cancel it drops the callback entirely - leaving them signed in
  // with their edits still in the form.
  await checkChanges(() => signOutAndForget());
};
