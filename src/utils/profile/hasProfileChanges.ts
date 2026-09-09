import { OnboardingFormInputs, User } from "../types";

/**
 * Whether the profile form holds anything the stored row does not — the rule
 * behind `UnsavedModal`.
 *
 * Lifted out of `checkForChanges` in `pages/profile/index.tsx`, where it was
 * fourteen comparisons chained into one boolean expression inside a component.
 * That shape is why SCRUM-381 went unnoticed: two of the fourteen compared
 * **the day of the month** rather than the instant.
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
 * picks, and `getDate()` cannot tell January from March from December.
 *
 * **Every month-to-month change was invisible, in every timezone.** Measured
 * against `dayjs("YYYY-MM").toDate()`:
 *
 * | timezone | pick Jan | pick Mar | same `getDate()`? |
 * | --- | --- | --- | --- |
 * | UTC | 2026-01-01T00:00Z | 2026-03-01T00:00Z | yes, both 1 |
 * | America/New_York | 2026-01-01T05:00Z | 2026-03-01T05:00Z | yes, both 1 |
 * | Europe/Berlin | 2025-12-31T23:00Z | 2026-02-28T23:00Z | yes, both 1 |
 *
 * SCRUM-381 predicted something narrower — that only months *sharing a last
 * day* would collide, sparing February — on the premise that
 * `lastDayOfMonthUTC` writes these fields. It does not. That function backs
 * `handleMonthChange`, whose only caller is the map filter panel in
 * `Sidebar/Filters.tsx`; `AccountSection.tsx` imports `handleMonthChange` and
 * never calls it. The profile's co-op dates have always come from the antd
 * picker, so the defect was total rather than partial.
 *
 * That dead import is filed as SCRUM-394, and the reason it matters is
 * SCRUM-393: the profile never adopted the UTC fix `lastDayOfMonthUTC` carries,
 * so east of UTC its picker stores the month *before* the one chosen. Both are
 * about the write; this file is only about detecting a change to it.
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

/** The form fields this rule compares, in the order the original listed them. */
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
  | "bio";

/**
 * Compares two nullable dates by instant.
 *
 * `?.` collapses both `null` and `undefined` to `undefined`, so an absent date
 * on each side counts as unchanged — which is what the original chain did and
 * what a profile with no co-op dates yet needs.
 *
 * An invalid `Date` yields `NaN`, and `NaN !== NaN`, so it always reports a
 * change. Unchanged from the original on both counts: `startTime` and `endTime`
 * already compared this way, and `getDate()` returned `NaN` for the same input.
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
 * and `reset(...)` maps the stored string one-for-one - and SCRUM-381 asked for
 * this to be confirmed and recorded rather than changed, because widening it
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
 * assert *which* term fired. That matters here specifically: the defect was one
 * wrong comparison among fourteen, and a boolean cannot tell "detected because
 * the date changed" from "detected because some unrelated term is always true".
 *
 * A `user` of `null` - the query has not resolved - leaves every stored value
 * `undefined`, so the form's own defaults read as changes. Preserved from the
 * original chain, which compared through `user?.`.
 */
export const profileChanges = (
  formValues: OnboardingFormInputs,
  user: User | null | undefined,
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
  // The two that compared `getDate()`. SCRUM-381.
  add(
    "coopStartDate",
    differentInstant(formValues.coopStartDate, user?.coopStartDate),
  );
  add(
    "coopEndDate",
    differentInstant(formValues.coopEndDate, user?.coopEndDate),
  );
  add("bio", formValues.bio !== user?.bio);

  return changed;
};

/** Whether anything at all differs — what `checkForChanges` gates the modal on. */
export const hasProfileChanges = (
  formValues: OnboardingFormInputs,
  user: User | null | undefined,
): boolean => profileChanges(formValues, user).length > 0;
