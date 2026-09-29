/**
 * The id an error message needs so a field's `aria-describedby` can resolve
 * to it. One function so every call site derives the same id from the same
 * field id - a mismatch here is a dangling `aria-describedby`, the likeliest
 * way to get this wrong (SCRUM-593).
 */
export const fieldErrorId = (fieldId: string): string => `${fieldId}-error`;

/**
 * `coopStartDate` and `coopEndDate` share one rendered error message in both
 * `StepThree` and `AccountSection` - a range problem can land on either
 * field, or both, and the UI has only ever shown one line for it. Both
 * date pickers point at this single id rather than at `fieldErrorId` of
 * their own name, so the description they carry matches the message that is
 * actually on screen.
 */
export const COOP_DATE_RANGE_ERROR_ID = "coop-date-range-error";
