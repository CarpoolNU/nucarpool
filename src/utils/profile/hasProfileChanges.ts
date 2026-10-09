import { OnboardingFormInputs, User } from "../types";
import { PendingPicture } from "./pendingPicture";

/**
 * Whether the profile form holds anything the stored row does not — the rule
 * behind `UnsavedModal`.
 *
 * Extracted from `checkForChanges` in `pages/profile/index.tsx`, where it was
 * fourteen comparisons chained into one boolean expression inside a component
 * — a shape that cannot be unit tested on its own, so a single wrong term is
 * easy to miss. Comparing the co-op dates by **the day of the month** rather
 * than by instant is exactly that kind of wrong term, and it is nearly
 * invisible:
 *
 * ```ts
 * formValues.startTime?.getTime()     !== user?.startTime?.getTime()     ||  // right
 * formValues.coopStartDate?.getDate() !== user?.coopStartDate?.getDate() ||  // wrong
 * ```
 *
 * `getDate()` is nearly harmless for an arbitrary date and specifically wrong
 * for these two, because of what writes them. The controls are antd
 * `DatePicker picker="month"`, and `AccountSection.tsx` stores
 * `date.toDate()` — which for a month selection is **the first of that month**,
 * every time. So the form's day-of-month is always `1`, whatever the user
 * picks, and `getDate()` cannot tell January from March from December: every
 * month-to-month change would compare equal, in every timezone, since a
 * month picker's `toDate()` lands on local midnight of the first regardless
 * of which zone reads it back.
 *
 * `lastDayOfMonthUTC` is not involved here, which matters because it is the
 * function that would otherwise seem like the fix: it backs
 * `handleMonthChange`, whose only caller is the map filter panel in
 * `Sidebar/Filters.tsx`. `AccountSection.tsx` imports `handleMonthChange` and
 * never calls it, so the profile's co-op dates come from the antd picker
 * alone, and the comparison below has to hold for every month pair, not just
 * ones that happen to share a last day.
 *
 * The profile has also never adopted the UTC fix `lastDayOfMonthUTC` carries,
 * so east of UTC its picker can store the month *before* the one chosen. That
 * is a write-path concern; this file is only about detecting a change to
 * whatever gets written.
 *
 * The cost is not only the lost edit. `dateOverlapFilter` and `calculateScore`
 * both read these dates, so the term the user thought they had corrected goes
 * on deciding who they match — and "my dates didn't save" and "my matches are
 * wrong" are far enough apart that nobody connects them.
 *
 * Extracted rather than fixed in place for the reason `connectAction.ts` and
 * `viewerAccess.ts` give: a rule that decides what a user can reach belongs
 * where a test can enumerate it. One wrong term among fourteen is invisible in
 * review and unreachable by a suite that cannot render the page.
 */

/**
 * The changes this rule can report, in the order the original listed them.
 *
 * `profilePicture` is last and is not one of the form comparisons: it is the
 * one profile change that does not live in the form at all. See the third
 * parameter of `profileChanges`.
 */
export type ProfileField =
  | "role"
  | "seatAvail"
  | "status"
  | "companyName"
  | "companyAddress"
  | "startAddress"
  | "preferredName"
  | "pronouns"
  | "daysWorking"
  | "startTime"
  | "endTime"
  | "coopStartDate"
  | "coopEndDate"
  | "bio"
  | "profilePicture";

/**
 * Compares two nullable dates by instant.
 *
 * `?.` collapses both `null` and `undefined` to `undefined`, so an absent date
 * on each side counts as unchanged — which is what the original chain did and
 * what a profile with no co-op dates yet needs.
 *
 * An invalid `Date` yields `NaN`, and `NaN !== NaN`, so it always reports a
 * change. `startTime` and `endTime` are compared the same way, so this helper
 * unifies all four date fields under one comparison.
 */
const differentInstant = (
  a: Date | null | undefined,
  b: Date | null | undefined,
): boolean => a?.getTime() !== b?.getTime();

/**
 * Compares the seven working-day checkboxes against the stored `"1,0,1,..."`.
 *
 * **Iterates the form's array, so it only reaches as far as that array goes.**
 * A stored value with more entries would have its extras ignored, and an absent
 * form array reports no change however many days are stored. Neither is
 * reachable today - `profileDefaultValues.daysWorking` is always seven booleans
 * and `reset(...)` maps the stored string one-for-one - and it was decided
 * to confirm and record this rather than change it, because widening it
 * would alter what the modal does for inputs the form cannot produce.
 */
const daysWorkingDiffer = (
  formDays: boolean[] | undefined,
  storedDays: string | undefined,
): boolean =>
  (formDays ?? []).some(
    (day, index) => day !== (storedDays?.split(",")[index] === "1"),
  );

/**
 * The fields in which the form differs from the stored row.
 *
 * Returned as names rather than folded straight into a boolean so a test can
 * assert *which* term fired. That matters here specifically: a boolean cannot
 * tell "detected because the date changed" from "detected because some
 * unrelated term is always true", and one wrong comparison among fourteen is
 * easy to miss without that distinction.
 *
 * A `user` of `null` - the query has not resolved - leaves every stored value
 * `undefined`, so the form's own defaults read as changes. Preserved from the
 * original chain, which compared through `user?.`.
 *
 * `pendingPicture` is the unsaved picture change, and it is the reason this
 * takes a third argument at all. Every other profile edit is a form field, so
 * comparing form values against the row answered "is anything unsaved?"
 * completely - until the picture, which `ProfilePicture` hands straight to page
 * state and which only the save handler ever applies. There is no form field
 * for it to live in: `user.edit` does not accept one, and there is no such
 * column - only `User.profilePictureUpdatedAt`, which the upload and removal
 * paths set from the server. So it cannot be compared against a stored value
 * the way the fourteen fields are; its mere presence *is* the change, which is
 * why this is a presence test rather than a comparison.
 *
 * A presence test is also what makes it indifferent to *which* change is
 * pending. A cropped `File` and the `"remove"` marker are both unsaved picture
 * changes and both have to arm the modal, so widening the parameter from
 * `File | null` to `PendingPicture` needed nothing here but the type - the one
 * place the single-slot model pays for itself.
 *
 * Absent, it reports no picture change - which is what every caller that has
 * no picture to lose wants, and what keeps this a drop-in for the two-argument
 * form.
 */
export const profileChanges = (
  formValues: OnboardingFormInputs,
  user: User | null | undefined,
  pendingPicture?: PendingPicture,
): ProfileField[] => {
  const changed: ProfileField[] = [];
  const add = (field: ProfileField, differs: boolean) => {
    if (differs) changed.push(field);
  };

  add("role", formValues.role !== user?.role);
  add("seatAvail", formValues.seatAvail !== user?.seatAvail);
  add("status", formValues.status !== user?.status);
  add("companyName", formValues.companyName !== user?.companyName);
  add("companyAddress", formValues.companyAddress !== user?.companyAddress);
  add("startAddress", formValues.startAddress !== user?.startAddress);
  add("preferredName", formValues.preferredName !== user?.preferredName);
  add("pronouns", formValues.pronouns !== user?.pronouns);
  add(
    "daysWorking",
    daysWorkingDiffer(formValues.daysWorking, user?.daysWorking),
  );
  add("startTime", differentInstant(formValues.startTime, user?.startTime));
  add("endTime", differentInstant(formValues.endTime, user?.endTime));
  // The two that compared `getDate()`.
  add(
    "coopStartDate",
    differentInstant(formValues.coopStartDate, user?.coopStartDate),
  );
  add(
    "coopEndDate",
    differentInstant(formValues.coopEndDate, user?.coopEndDate),
  );
  add("bio", formValues.bio !== user?.bio);
  // Last, and outside the form. A cropped file - or a pending removal - with no
  // field touched is a real unsaved change that none of the form comparisons
  // above can see on their own.
  add("profilePicture", !!pendingPicture);

  return changed;
};

/** Whether anything at all differs — what `checkForChanges` gates the modal on. */
export const hasProfileChanges = (
  formValues: OnboardingFormInputs,
  user: User | null | undefined,
  pendingPicture?: PendingPicture,
): boolean => profileChanges(formValues, user, pendingPicture).length > 0;
