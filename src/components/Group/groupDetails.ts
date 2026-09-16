/**
 * The driver's group preferences.
 *
 * Extracted from `GroupPage.tsx`, where four components each held
 * their own copy of the parse/serialise/state wiring. Pure functions live here
 * so they can be unit tested; the React wiring is in `useGroupDetails.ts`.
 *
 * These are real columns on the driver's `CarpoolSearch`. They were once a
 * `GROUP_DETAILS_V1:` JSON blob in `carpool_search.group_message`, read through
 * a fallback here while rows were migrated; SCRUM-287 dropped the column after
 * `scripts/backfill-group-preferences.ts` had run in every environment, and the
 * fallback went with it. Reads are now just the three columns.
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
 * A separate `normalizeDetails` used to clamp on read, because a corrupt
 * `GROUP_DETAILS_V1:` blob surfaced as raw note text that could be far longer
 * than `group_notes` accepts. With the legacy column dropped every value
 * reaching a read has come out of a `VARCHAR(90)` or `VARCHAR(40)` column,
 * written through a Zod input holding it to the same limit, so the clamp was a
 * no-op and the two functions were identical.
 *
 * Removing it is also the safer half. `textLimits.ts` counts UTF-16 code units
 * while MySQL counts characters, so a column-legal note of emoji has a JS
 * `length` above the limit; a `slice` on read would have cut a value the
 * database was perfectly happy to store. Not clamping on write is the same
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
 * The single read path every screen uses.
 *
 * `NoGroupSection` used to read `user.groupMessage` while `GroupSection` read
 * `group.message`, so a driver could see different preferences depending on
 * whether they had a group yet. Both now resolve through this.
 *
 * Null and `""` both read as empty, and no longer need telling apart. While the
 * legacy column existed all-three-null meant "never saved" and selected the
 * fallback, so a driver who cleared the form had to store `""` to stop the old
 * blob coming back. With the column dropped there is nothing to fall back to,
 * and a save still writes all three regardless.
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
