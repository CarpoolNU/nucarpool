/**
 * The driver's group preferences.
 *
 * Pure functions, kept out of `GroupPage.tsx`'s components so they can be
 * unit tested independently of React; the wiring that uses them is in
 * `useGroupDetails.ts`.
 *
 * These are real columns on the driver's `CarpoolSearch`. Reads are just the
 * three columns.
 */

import { GROUP_NOTES_MAX_LENGTH } from "../../utils/textLimits";

export type GroupDetails = {
  notes: string;
  musicPreference: string;
  conversationStyle: string;
};

/**
 * Re-exported under the name the form already uses. The values live in
 * `textLimits.ts` so the Zod input on the server and the textarea here cannot
 * drift from the column widths.
 */
export const NOTES_MAX_LENGTH = GROUP_NOTES_MAX_LENGTH;

export const DEFAULT_GROUP_DETAILS: GroupDetails = {
  notes: "",
  musicPreference: "",
  conversationStyle: "",
};

export const musicPreferenceOptions = [
  "No preference",
  "Pop",
  "Hip-hop",
  "R&B",
  "Electronic",
  "Rock",
  "Podcasts",
  "Quiet ride",
];

export const conversationStyleOptions = [
  "No preference",
  "Quiet",
  "Light chat",
  "Talkative",
  "Depends on mood",
];

/**
 * Tidies a value without shortening it. Both paths use it.
 *
 * Every value reaching a read comes out of a `VARCHAR(90)` or `VARCHAR(40)`
 * column, written through a Zod input holding it to the same limit, so a
 * separate read-time clamp would be a no-op - there is only this one
 * function.
 *
 * Not clamping at all is also the safer choice. `textLimits.ts` counts UTF-16
 * code units while MySQL counts characters, so a column-legal note of emoji
 * has a JS `length` above the limit; a `slice` on read would cut a value the
 * database is perfectly happy to store. Not clamping on write is the same
 * decision made deliberately — the server rejects an over-length value visibly
 * rather than truncating it behind the driver's back.
 */
export const trimDetails = (details: GroupDetails): GroupDetails => ({
  notes: details.notes.trim(),
  musicPreference: details.musicPreference.trim(),
  conversationStyle: details.conversationStyle.trim(),
});

export const hasAnyDetail = (details: GroupDetails): boolean =>
  Object.values(trimDetails(details)).some((value) => value !== "");

/**
 * The fields `detailsEqual` compares, as a `Record` over every key of
 * `GroupDetails`.
 *
 * The indirection buys one thing, and it is worth four lines. A comparison
 * written as `a.notes === b.notes && ...` silently ignores a fourth field
 * added to `GroupDetails` later - and silently ignoring a field here means the
 * effect in `useGroupDetails` treats a change to it as "no change" and never
 * puts it in the form, which is a quieter version of the bug this comparison
 * exists to fix. `Record<keyof GroupDetails, true>` makes that a compile error
 * instead: adding `smokingPreference` to the type without adding it below
 * fails `tsc`.
 *
 * `trimDetails` gets the same protection for free, because it returns a
 * `GroupDetails` literal and a missing property is an error. A predicate
 * returning `boolean` has no such check, so it needs this.
 */
const COMPARED_FIELDS: Record<keyof GroupDetails, true> = {
  notes: true,
  musicPreference: true,
  conversationStyle: true,
};

/**
 * Whether two sets of details carry the same values.
 *
 * `resolveGroupDetails` builds a new object on every call, so no caller can
 * compare two of its results with `===`. `useGroupDetails` has to: its sync
 * effect writes the resolved value into state, and without a value comparison
 * every resolve is a state change and every state change is a render - which
 * is the loop this avoids.
 */
export const detailsEqual = (a: GroupDetails, b: GroupDetails): boolean =>
  (Object.keys(COMPARED_FIELDS) as (keyof GroupDetails)[]).every(
    (field) => a[field] === b[field],
  );

/** The three stored columns, as they arrive from the API. */
export type StoredGroupPreferences = {
  groupNotes?: string | null;
  groupMusicPreference?: string | null;
  groupConversationStyle?: string | null;
};

/**
 * The single read path every screen uses, so a driver sees the same
 * preferences whether or not they have a group yet.
 *
 * Null and `""` both read as empty and are not told apart: a save always
 * writes all three columns, so there is nothing to fall back to.
 */
export const resolveGroupDetails = (
  stored: StoredGroupPreferences | null | undefined,
): GroupDetails => {
  if (!stored) {
    return DEFAULT_GROUP_DETAILS;
  }

  return trimDetails({
    notes: stored.groupNotes ?? "",
    musicPreference: stored.groupMusicPreference ?? "",
    conversationStyle: stored.groupConversationStyle ?? "",
  });
};
