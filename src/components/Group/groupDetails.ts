/**
 * The driver's group preferences, and the encoding used to squeeze them into a
 * single free-text column.
 *
 * Extracted from `GroupPage.tsx` (SCRUM-252), where four components each held
 * their own copy of the parse/serialise/state wiring. Pure functions live here
 * so they can be unit tested; the React wiring is in `useGroupDetails.ts`.
 *
 * The encoding itself is not a good design - it is a JSON blob in a column that
 * is meant for prose, mirrored into a second column on another table. That is
 * SCRUM-253, not this module's problem to fix.
 */

export type GroupDetails = {
  notes: string;
  musicPreference: string;
  conversationStyle: string;
};

/**
 * Marks a value as the JSON encoding rather than a legacy plain-text message.
 * Bumping the version means teaching `parseGroupDetails` the old shape too -
 * rows are never migrated.
 */
export const GROUP_DETAILS_PREFIX = "GROUP_DETAILS_V1:";

/** What the note textarea accepts, and what `normalizeDetails` truncates to. */
export const NOTES_MAX_LENGTH = 90;

/** Ceiling for the two fixed-choice fields. Every real option is far shorter. */
const OPTION_MAX_LENGTH = 40;

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

export const normalizeDetails = (details: GroupDetails): GroupDetails => ({
  notes: details.notes.slice(0, NOTES_MAX_LENGTH).trim(),
  musicPreference: details.musicPreference.slice(0, OPTION_MAX_LENGTH).trim(),
  conversationStyle: details.conversationStyle
    .slice(0, OPTION_MAX_LENGTH)
    .trim(),
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
      // retired `rideVibe` field (SCRUM-252) disappears from a row: it is
      // ignored on read, and the next save writes the value back without it.
      return normalizeDetails({
        notes: parsed.notes ?? "",
        musicPreference: parsed.musicPreference ?? "",
        conversationStyle: parsed.conversationStyle ?? "",
      });
    } catch {
      // Deliberately unchanged from the pre-refactor behaviour: a corrupt blob
      // surfaces raw in the note field, prefix included. Not normalized either,
      // so it can read back longer than NOTES_MAX_LENGTH until the next save
      // truncates it. Ugly, but a refactor is not the place to change what the
      // user sees.
      return { ...DEFAULT_GROUP_DETAILS, notes: message };
    }
  }

  // A message written before the JSON encoding existed is all note.
  return { ...DEFAULT_GROUP_DETAILS, notes: message };
};

export const serializeGroupDetails = (details: GroupDetails): string => {
  const normalized = normalizeDetails(details);

  // An all-empty form stores "" rather than an encoded empty object, so
  // `parseGroupDetails` short-circuits and the preview shows its empty state.
  if (!hasAnyDetail(normalized)) {
    return "";
  }

  return `${GROUP_DETAILS_PREFIX}${JSON.stringify(normalized)}`;
};
