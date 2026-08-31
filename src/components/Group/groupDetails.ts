/**
 * The driver's group preferences.
 *
 * Extracted from `GroupPage.tsx`, where four components each held
 * their own copy of the parse/serialise/state wiring. Pure functions live here
 * so they can be unit tested; the React wiring is in `useGroupDetails.ts`.
 *
 * These are real columns on the driver's `CarpoolSearch` now.
 * Everything below about `GROUP_DETAILS_V1:` is a **read path for rows that
 * have not been backfilled yet** and nothing writes that encoding any more.
 * Once `scripts/backfill-group-preferences.ts` has run in every environment and
 * `carpool_search.group_message` is dropped, the legacy half of this module goes
 * with it.
 */

import {
  GROUP_NOTES_MAX_LENGTH,
  GROUP_OPTION_MAX_LENGTH,
} from "../../utils/textLimits";

export type GroupDetails = {
  notes: string;
  musicPreference: string;
  conversationStyle: string;
};

/**
 * Marks a legacy value as the JSON encoding rather than a plain-text message.
 * Read-only: no code writes this prefix any more.
 */
export const GROUP_DETAILS_PREFIX = "GROUP_DETAILS_V1:";

/**
 * Re-exported under the name the form already uses. The values live in
 * `textLimits.ts` so the Zod input on the server and the textarea here cannot
 * drift from the column widths.
 */
export const NOTES_MAX_LENGTH = GROUP_NOTES_MAX_LENGTH;

const OPTION_MAX_LENGTH = GROUP_OPTION_MAX_LENGTH;

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
 * Clamps stored values to the column widths. **Read path only.**
 *
 * This used to run on the way *in* as well, which truncated silently:
 * whatever the user had typed was sliced to fit with no indication. Writes use `trimDetails` and let the Zod input reject an
 * over-length value, so the user hears about it.
 *
 * Clamping on read still matters, because a corrupt legacy blob surfaces as raw
 * note text that can be far longer than the column now allows.
 */
export const normalizeDetails = (details: GroupDetails): GroupDetails => ({
  notes: details.notes.slice(0, NOTES_MAX_LENGTH).trim(),
  musicPreference: details.musicPreference.slice(0, OPTION_MAX_LENGTH).trim(),
  conversationStyle: details.conversationStyle
    .slice(0, OPTION_MAX_LENGTH)
    .trim(),
});

/**
 * Tidies a value for saving without shortening it. **Write path.**
 *
 * Deliberately does not clamp: the textarea already bounds what can be typed, so
 * an over-length value reaching here is a bug, and the server rejecting it with
 * a visible error beats this function hiding it.
 */
export const trimDetails = (details: GroupDetails): GroupDetails => ({
  notes: details.notes.trim(),
  musicPreference: details.musicPreference.trim(),
  conversationStyle: details.conversationStyle.trim(),
});

export const hasAnyDetail = (details: GroupDetails): boolean =>
  Object.values(normalizeDetails(details)).some((value) => value !== "");

export const parseGroupDetails = (message?: string | null): GroupDetails => {
  if (!message) {
    return DEFAULT_GROUP_DETAILS;
  }

  if (message.startsWith(GROUP_DETAILS_PREFIX)) {
    try {
      const parsed = JSON.parse(
        message.slice(GROUP_DETAILS_PREFIX.length),
      ) as Partial<GroupDetails>;

      // Unknown keys are dropped rather than preserved, which is how the
      // retired `rideVibe` field disappears from a row: it is
      // ignored on read, and the next save writes the value back without it.
      return normalizeDetails({
        notes: parsed.notes ?? "",
        musicPreference: parsed.musicPreference ?? "",
        conversationStyle: parsed.conversationStyle ?? "",
      });
    } catch {
      // A corrupt blob still surfaces raw in the note field, prefix included -
      // better visible than discarded. It *is* clamped, because
      // the form has to hold a value the column can accept, or the
      // driver would be unable to save at all until they trimmed text they
      // never wrote.
      return normalizeDetails({ ...DEFAULT_GROUP_DETAILS, notes: message });
    }
  }

  // A message written before the JSON encoding existed is all note. Clamped for
  // the same reason as the corrupt branch above: `group_message` was TEXT, so a
  // legacy value can be longer than `group_notes` accepts.
  return normalizeDetails({ ...DEFAULT_GROUP_DETAILS, notes: message });
};

/** The three stored columns, as they arrive from the API. */
export type StoredGroupPreferences = {
  groupNotes?: string | null;
  groupMusicPreference?: string | null;
  groupConversationStyle?: string | null;
  /** The legacy column, read only when the three above are all null. */
  groupMessage?: string | null;
};

/**
 * The single read path every screen uses.
 *
 * `NoGroupSection` used to read `user.groupMessage` while `GroupSection` read
 * `group.message`, so a driver could see different preferences depending on
 * whether they had a group yet. Both now resolve through this.
 *
 * **All three columns null means "never saved", not "empty."** That distinction
 * is what makes the fallback safe: without it, a driver who deliberately cleared
 * the form would have the legacy blob resurrected on the next read, because
 * cleared and un-migrated would look identical. A save always writes all three,
 * so an intentionally blank form stores "" and stops the fallback for good.
 */
export const resolveGroupDetails = (
  stored: StoredGroupPreferences | null | undefined,
): GroupDetails => {
  if (!stored) {
    return DEFAULT_GROUP_DETAILS;
  }

  // `!= null` deliberately, covering undefined as well: a field the caller did
  // not select must count as "not saved", not as an empty saved value.
  const migrated =
    stored.groupNotes != null ||
    stored.groupMusicPreference != null ||
    stored.groupConversationStyle != null;

  if (migrated) {
    return normalizeDetails({
      notes: stored.groupNotes ?? "",
      musicPreference: stored.groupMusicPreference ?? "",
      conversationStyle: stored.groupConversationStyle ?? "",
    });
  }

  return parseGroupDetails(stored.groupMessage);
};
